import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  activateVersion,
  ensureLauncher,
  extractVersionArchive,
  installedVersions,
  readActiveInstallation,
  readReleaseManifest,
  registerCurrentInstallation,
  restoreActiveInstallation,
} from "./installation";
import { installService } from "./onboard";
import { applicationRoot, configPath, readConfig } from "./runtime-config";
import type { ServiceRole } from "./runtime-config";

interface ReleaseAsset {
  browser_download_url: string;
  name: string;
}
interface GithubRelease {
  assets: ReleaseAsset[];
  prerelease: boolean;
  tag_name: string;
}

const releaseAssetSchema = z.object({
  browser_download_url: z.url(),
  name: z.string(),
});
const githubReleaseSchema: z.ZodType<GithubRelease> = z.object({
  assets: z.array(releaseAssetSchema),
  prerelease: z.boolean(),
  tag_name: z.string(),
});

const releaseHeaders = () => {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "TokTracker updater",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
};

const fetchReleaseJson = async <Value>(
  url: string,
  schema: z.ZodType<Value>
): Promise<Value> => {
  const response = await fetch(url, { headers: releaseHeaders() });
  if (!response.ok) {
    throw new Error(
      `GitHub returned HTTP ${response.status}: ${await response.text()}`
    );
  }
  return schema.parse(await response.json());
};

const findRelease = async (
  repository: string,
  channel: "nightly" | "stable",
  requestedVersion?: string
): Promise<GithubRelease> => {
  const apiRoot = `https://api.github.com/repos/${repository}/releases`;
  if (requestedVersion) {
    return fetchReleaseJson(
      `${apiRoot}/tags/${encodeURIComponent(requestedVersion)}`,
      githubReleaseSchema
    );
  }
  if (channel === "stable") {
    return fetchReleaseJson(`${apiRoot}/latest`, githubReleaseSchema);
  }
  const releases = await fetchReleaseJson(
    `${apiRoot}?per_page=30`,
    z.array(githubReleaseSchema)
  );
  const nightly = releases.find(
    (release) => release.prerelease && release.tag_name.startsWith("nightly-")
  );
  if (!nightly) {
    throw new Error("No nightly release is available");
  }
  return nightly;
};

export const restartService = (role: ServiceRole): boolean => {
  if (platform() === "linux") {
    return (
      Bun.spawnSync(["systemctl", "--user", "restart", `toktracker-${role}`])
        .exitCode === 0
    );
  }
  if (platform() === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    return (
      Bun.spawnSync([
        "launchctl",
        "kickstart",
        "-k",
        `${domain}/dev.toktracker.${role}`,
      ]).exitCode === 0
    );
  }
  if (platform() === "win32") {
    const taskName = `TokTracker ${role}`;
    Bun.spawnSync(["schtasks.exe", "/End", "/TN", taskName]);
    return (
      Bun.spawnSync(["schtasks.exe", "/Run", "/TN", taskName]).exitCode === 0
    );
  }
  return false;
};

const verifyServiceStarted = async (
  role: ServiceRole,
  config: Record<string, string>
): Promise<boolean> => {
  await Bun.sleep(750);
  if (role === "gateway") {
    const configuredHost = config.HOST ?? "127.0.0.1";
    const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
    const port = config.PORT ?? "3000";
    const key = config.TOKTRACKER_API_KEY;
    try {
      const response = await fetch(`http://${host}:${port}/api/health`, {
        headers: key ? { authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  if (platform() === "linux") {
    return (
      Bun.spawnSync([
        "systemctl",
        "--user",
        "is-active",
        "--quiet",
        `toktracker-${role}`,
      ]).exitCode === 0
    );
  }
  if (platform() === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    return (
      Bun.spawnSync(["launchctl", "print", `${domain}/dev.toktracker.${role}`])
        .exitCode === 0
    );
  }
  return platform() === "win32";
};

const downloadVerifiedArchive = async (
  asset: ReleaseAsset,
  checksumAsset: ReleaseAsset,
  archivePath: string
): Promise<void> => {
  const response = await fetch(asset.browser_download_url, {
    headers: releaseHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  await Bun.write(archivePath, response);
  const checksumResponse = await fetch(checksumAsset.browser_download_url, {
    headers: releaseHeaders(),
  });
  if (!checksumResponse.ok) {
    throw new Error(
      `Checksum download failed with HTTP ${checksumResponse.status}`
    );
  }
  const checksumContents = await checksumResponse.text();
  const [expectedChecksum] = checksumContents.trim().split(/\s+/u);
  const archiveBytes = await Bun.file(archivePath).arrayBuffer();
  const actualChecksum = new Bun.CryptoHasher("sha256")
    .update(archiveBytes)
    .digest("hex");
  if (!expectedChecksum || actualChecksum !== expectedChecksum.toLowerCase()) {
    throw new Error("Release archive checksum verification failed");
  }
};

export const switchInstalledVersion = async (
  role: ServiceRole,
  version: string
): Promise<void> => {
  const active = await readActiveInstallation(role);
  if (active?.version === version) {
    await ensureLauncher(role);
    return;
  }
  const config = await readConfig(role);
  const hasService = await Bun.file(configPath(role)).exists();
  const previous = await activateVersion(role, version);
  await ensureLauncher(role);
  if (!hasService) {
    return;
  }

  try {
    await installService(role);
    if (!restartService(role) || !(await verifyServiceStarted(role, config))) {
      throw new Error(`TokTracker ${role} ${version} did not start`);
    }
  } catch (error) {
    console.error(
      "Activation failed; restoring the previous TokTracker version"
    );
    await restoreActiveInstallation(role, previous);
    await ensureLauncher(role);
    let rollbackStarted = false;
    try {
      await installService(role);
      rollbackStarted =
        restartService(role) && (await verifyServiceStarted(role, config));
    } catch {
      rollbackStarted = false;
    }
    if (!rollbackStarted) {
      throw new Error("Activation and automatic rollback both failed", {
        cause: error,
      });
    }
    throw new Error("Activation failed; the previous version was restored", {
      cause: error,
    });
  }
};

export const updateRole = async (
  role: ServiceRole,
  requestedChannel?: "nightly" | "stable",
  force = false,
  requestedVersion?: string
): Promise<void> => {
  const currentManifest = await registerCurrentInstallation(role);
  const localManifest =
    currentManifest ?? (await readReleaseManifest(applicationRoot()));
  const repository =
    process.env.TOKTRACKER_RELEASE_REPOSITORY ?? localManifest?.repository;
  if (!repository) {
    throw new Error(
      "Release repository is unknown. Install a release package or set TOKTRACKER_RELEASE_REPOSITORY."
    );
  }
  const config = await readConfig(role);
  const configuredChannel = config.TOKTRACKER_UPDATE_CHANNEL;
  const channel =
    requestedChannel ??
    (configuredChannel === "nightly" ? "nightly" : "stable");
  const release = await findRelease(repository, channel, requestedVersion);
  const active = await readActiveInstallation(role);
  if (!force && active?.version === release.tag_name) {
    console.log(`TokTracker ${role} is already on ${release.tag_name}`);
    return;
  }
  const assetName = `toktracker-${role}-${release.tag_name}.tgz`;
  const asset = release.assets.find(
    (candidate) => candidate.name === assetName
  );
  const checksumAsset = release.assets.find(
    (candidate) => candidate.name === `${assetName}.sha256`
  );
  if (!asset || !checksumAsset) {
    throw new Error(
      `Release ${release.tag_name} does not contain ${assetName} and its checksum`
    );
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "toktracker-update-")
  );
  const archivePath = path.join(temporaryRoot, assetName);
  try {
    await downloadVerifiedArchive(asset, checksumAsset, archivePath);
    await extractVersionArchive(role, release.tag_name, archivePath);
    await switchInstalledVersion(role, release.tag_name);
    console.log(
      `Updated TokTracker ${role} to ${release.tag_name} (${channel})`
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true }).catch(
      () => false
    );
  }
};

export const listInstalledVersions = async (
  role: ServiceRole
): Promise<void> => {
  const active = await readActiveInstallation(role);
  const versions = await installedVersions(role);
  if (versions.length === 0) {
    console.log(`No TokTracker ${role} versions are installed`);
    return;
  }
  for (const version of versions) {
    const marker = active?.version === version ? "*" : " ";
    console.log(`${marker} ${version}`);
  }
};

export const rollbackRole = async (role: ServiceRole): Promise<void> => {
  const active = await readActiveInstallation(role);
  if (!active?.previousVersion) {
    throw new Error(`No previous TokTracker ${role} version is available`);
  }
  const target = active.previousVersion;
  await switchInstalledVersion(role, target);
  console.log(`Rolled back TokTracker ${role} to ${target}`);
};
