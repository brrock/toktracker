import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { applicationDirectory, applicationRoot } from "./runtime-config";
import type { ServiceRole } from "./runtime-config";

export interface ReleaseManifest {
  repository: string;
  role: ServiceRole;
  version: string;
}

export interface ActiveInstallation {
  previousVersion?: string;
  version: string;
}

const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

const assertVersion = (version: string): void => {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
};

export const roleInstallationDirectory = (role: ServiceRole): string =>
  path.join(applicationDirectory(), "installs", role);

export const versionsDirectory = (role: ServiceRole): string =>
  path.join(roleInstallationDirectory(role), "versions");

export const versionDirectory = (
  role: ServiceRole,
  version: string
): string => {
  assertVersion(version);
  return path.join(versionsDirectory(role), version);
};

export const activeInstallationPath = (role: ServiceRole): string =>
  path.join(roleInstallationDirectory(role), "active.json");

export const launcherPath = (role: ServiceRole): string =>
  path.join(applicationDirectory(), "bin", `launcher-${role}.js`);

export const readReleaseManifest = async (
  root: string
): Promise<ReleaseManifest | undefined> => {
  const file = Bun.file(path.join(root, "release.json"));
  if (!(await file.exists())) {
    return undefined;
  }
  const value = (await file.json()) as Partial<ReleaseManifest>;
  if (
    (value.role !== "client" && value.role !== "gateway") ||
    typeof value.repository !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error(`Invalid release manifest in ${root}`);
  }
  assertVersion(value.version);
  return value as ReleaseManifest;
};

export const readActiveInstallation = async (
  role: ServiceRole
): Promise<ActiveInstallation | undefined> => {
  const file = Bun.file(activeInstallationPath(role));
  if (!(await file.exists())) {
    return undefined;
  }
  const value = (await file.json()) as Partial<ActiveInstallation>;
  if (typeof value.version !== "string") {
    throw new TypeError(`Invalid active installation metadata for ${role}`);
  }
  assertVersion(value.version);
  if (value.previousVersion !== undefined) {
    assertVersion(value.previousVersion);
  }
  return value as ActiveInstallation;
};

const writeActiveInstallation = async (
  role: ServiceRole,
  active: ActiveInstallation
): Promise<void> => {
  const directory = roleInstallationDirectory(role);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.active-${crypto.randomUUID()}.json`
  );
  await Bun.write(temporaryPath, `${JSON.stringify(active, null, 2)}\n`);
  await rename(temporaryPath, activeInstallationPath(role));
};

export const activateVersion = async (
  role: ServiceRole,
  version: string
): Promise<ActiveInstallation | undefined> => {
  const root = versionDirectory(role, version);
  const manifest = await readReleaseManifest(root);
  if (!manifest || manifest.role !== role || manifest.version !== version) {
    throw new Error(`TokTracker ${role} ${version} is not installed correctly`);
  }
  const previous = await readActiveInstallation(role);
  await writeActiveInstallation(role, {
    previousVersion: previous?.version,
    version,
  });
  return previous;
};

export const restoreActiveInstallation = async (
  role: ServiceRole,
  active: ActiveInstallation | undefined
): Promise<void> => {
  if (!active) {
    await rm(activeInstallationPath(role), { force: true });
    return;
  }
  await writeActiveInstallation(role, active);
};

const validateArchiveEntries = (contents: string): void => {
  const entries = contents.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("Release archive is empty");
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, "");
    const components = normalized.split("/");
    if (
      components[0] !== "package" ||
      components.some(
        (component) =>
          component === ".." || component === "." || component.includes("\\")
      )
    ) {
      throw new Error(`Unsafe path in release archive: ${entry}`);
    }
  }
};

const validateInstalledVersion = async (
  role: ServiceRole,
  version: string,
  root: string
): Promise<void> => {
  const manifest = await readReleaseManifest(root);
  if (!manifest || manifest.role !== role || manifest.version !== version) {
    throw new Error(
      "The extracted release manifest does not match the release"
    );
  }
  const cli = Bun.file(path.join(root, "apps", role, "dist", "cli.js"));
  const service = Bun.file(path.join(root, "apps", role, "dist", "index.js"));
  if (!(await cli.exists()) || !(await service.exists())) {
    throw new Error("The extracted release is missing required entrypoints");
  }
};

export const extractVersionArchive = async (
  role: ServiceRole,
  version: string,
  archivePath: string
): Promise<string> => {
  assertVersion(version);
  const destination = versionDirectory(role, version);
  if (await Bun.file(path.join(destination, "release.json")).exists()) {
    await validateInstalledVersion(role, version, destination);
    return destination;
  }

  const listing = Bun.spawnSync(["tar", "-tzf", archivePath]);
  if (listing.exitCode !== 0) {
    throw new Error("Could not inspect the release archive");
  }
  validateArchiveEntries(new TextDecoder().decode(listing.stdout));

  await mkdir(versionsDirectory(role), { recursive: true });
  const staging = await mkdtemp(
    path.join(versionsDirectory(role), `.staging-${version}-`)
  );
  try {
    const extraction = Bun.spawnSync([
      "tar",
      "-xzf",
      archivePath,
      "-C",
      staging,
      "--strip-components=1",
    ]);
    if (extraction.exitCode !== 0) {
      throw new Error("Could not extract the release archive");
    }
    await validateInstalledVersion(role, version, staging);
    await rename(staging, destination);
    return destination;
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
};

export const registerCurrentInstallation = async (
  role: ServiceRole
): Promise<ReleaseManifest | undefined> => {
  const root = applicationRoot();
  const manifest = await readReleaseManifest(root);
  if (!manifest || manifest.role !== role) {
    return undefined;
  }
  const destination = versionDirectory(role, manifest.version);
  const destinationExists = await Bun.file(
    path.join(destination, "release.json")
  ).exists();
  if (path.resolve(root) !== path.resolve(destination) && !destinationExists) {
    await mkdir(versionsDirectory(role), { recursive: true });
    const staging = await mkdtemp(
      path.join(versionsDirectory(role), `.staging-${manifest.version}-`)
    );
    try {
      await cp(root, staging, { recursive: true });
      await validateInstalledVersion(role, manifest.version, staging);
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      throw error;
    }
  }
  if (!(await readActiveInstallation(role))) {
    await activateVersion(role, manifest.version);
  }
  return manifest;
};

const launcherContents = (role: ServiceRole): string => {
  const activePath = activeInstallationPath(role);
  const versionsRoot = versionsDirectory(role);
  return `const active = await Bun.file(${JSON.stringify(activePath)}).json();\nif (typeof active.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(active.version)) throw new Error("Invalid active TokTracker installation");\nconst cli = ${JSON.stringify(versionsRoot)} + "/" + active.version + "/apps/${role}/dist/cli.js";\nif (!(await Bun.file(cli).exists())) throw new Error(\`TokTracker ${role} \${active.version} is missing\`);\nconst child = Bun.spawn([process.execPath, cli, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });\nprocess.on("SIGINT", () => child.kill());\nprocess.on("SIGTERM", () => child.kill());\nprocess.exitCode = await child.exited;\n`;
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const globalBinDirectory = (): string => {
  if (process.env.TOKTRACKER_BIN_DIR) {
    return path.resolve(process.env.TOKTRACKER_BIN_DIR);
  }
  const result = Bun.spawnSync([process.execPath, "pm", "bin", "--global"]);
  if (result.exitCode !== 0) {
    throw new Error("Could not locate Bun's global command directory");
  }
  return new TextDecoder().decode(result.stdout).trim();
};

export const ensureLauncher = async (role: ServiceRole): Promise<string> => {
  const destination = launcherPath(role);
  await mkdir(path.dirname(destination), { recursive: true });
  await Bun.write(destination, launcherContents(role));

  const binDirectory = globalBinDirectory();
  await mkdir(binDirectory, { recursive: true });
  const commandName = `toktracker-${role}`;
  if (process.platform === "win32") {
    const shim = path.join(binDirectory, `${commandName}.cmd`);
    await rm(shim, { force: true });
    await Bun.write(
      shim,
      `@echo off\r\n"${process.execPath}" "${destination}" %*\r\n`
    );
  } else {
    const shim = path.join(binDirectory, commandName);
    await rm(shim, { force: true });
    await Bun.write(
      shim,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(destination)} "$@"\n`
    );
    await chmod(shim, 0o755);
  }
  return destination;
};

export const installedVersions = async (
  role: ServiceRole
): Promise<string[]> => {
  try {
    const entries = await readdir(versionsDirectory(role), {
      withFileTypes: true,
    });
    return entries
      .filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith(".staging-")
      )
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
};
