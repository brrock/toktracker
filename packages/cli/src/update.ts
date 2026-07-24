import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";

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
interface ReleaseManifest {
  repository: string;
  role: ServiceRole;
  version: string;
}

const releaseHeaders = (): Record<string, string> => ({
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
  "user-agent": "TokTracker updater",
  "x-github-api-version": "2022-11-28",
});

const fetchJson = async <Value>(url: string): Promise<Value> => {
  const response = await fetch(url, { headers: releaseHeaders() });
  if (!response.ok) {
    throw new Error(
      `GitHub returned HTTP ${response.status}: ${await response.text()}`
    );
  }
  return (await response.json()) as Value;
};

const localManifest = async (): Promise<ReleaseManifest | undefined> => {
  const file = Bun.file(path.join(applicationRoot(), "release.json"));
  return (await file.exists())
    ? ((await file.json()) as ReleaseManifest)
    : undefined;
};

const findRelease = async (
  repository: string,
  channel: "nightly" | "stable"
): Promise<GithubRelease> => {
  const apiRoot = `https://api.github.com/repos/${repository}/releases`;
  if (channel === "stable") {
    return fetchJson<GithubRelease>(`${apiRoot}/latest`);
  }
  const releases = await fetchJson<GithubRelease[]>(`${apiRoot}?per_page=30`);
  const nightly = releases.find(
    (release) => release.prerelease && release.tag_name.startsWith("nightly-")
  );
  if (!nightly) {
    throw new Error("No nightly release is available");
  }
  return nightly;
};

export const restartService = (role: ServiceRole): void => {
  if (platform() === "linux") {
    Bun.spawnSync(["systemctl", "--user", "restart", `toktracker-${role}`]);
    return;
  }
  if (platform() === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    Bun.spawnSync([
      "launchctl",
      "kickstart",
      "-k",
      `${domain}/dev.toktracker.${role}`,
    ]);
    return;
  }
  if (platform() === "win32") {
    const taskName = `TokTracker ${role}`;
    Bun.spawnSync(["schtasks.exe", "/End", "/TN", taskName]);
    Bun.spawnSync(["schtasks.exe", "/Run", "/TN", taskName]);
  }
};

export const updateRole = async (
  role: ServiceRole,
  requestedChannel?: "nightly" | "stable",
  force = false
): Promise<void> => {
  const manifest = await localManifest();
  const repository =
    process.env.TOKTRACKER_RELEASE_REPOSITORY ?? manifest?.repository;
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
  const release = await findRelease(repository, channel);
  if (!force && manifest?.version === release.tag_name) {
    console.log(`TokTracker ${role} is already on ${release.tag_name}`);
    return;
  }
  const assetName = `toktracker-${role}-${release.tag_name}.tgz`;
  const asset = release.assets.find(
    (candidate) => candidate.name === assetName
  );
  if (!asset) {
    throw new Error(
      `Release ${release.tag_name} does not contain ${assetName}`
    );
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "toktracker-update-")
  );
  const archivePath = path.join(temporaryRoot, assetName);
  try {
    const response = await fetch(asset.browser_download_url, {
      headers: releaseHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }
    await Bun.write(archivePath, response);
    const packageName = `@toktracker/${role}-cli`;
    const removal = Bun.spawnSync(
      [process.execPath, "remove", "--global", packageName],
      { stderr: "inherit", stdout: "inherit" }
    );
    if (removal.exitCode !== 0) {
      throw new Error("Bun could not remove the current package for update");
    }
    const installation = Bun.spawnSync(
      [process.execPath, "add", "--global", archivePath],
      { stderr: "inherit", stdout: "inherit" }
    );
    if (installation.exitCode !== 0) {
      throw new Error("Bun could not install the update package");
    }
    if (await Bun.file(configPath(role)).exists()) {
      restartService(role);
    }
    console.log(
      `Updated TokTracker ${role} to ${release.tag_name} (${channel})`
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true }).catch(
      () => false
    );
  }
};
