/* eslint-disable vitest/prefer-importing-vitest-globals */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  activateVersion,
  ensureLauncher,
  extractVersionArchive,
  installedVersions,
  readActiveInstallation,
} from "../src/installation";

const temporaryRoots: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "toktracker-install-test-"));
  temporaryRoots.push(root);
  process.env.TOKTRACKER_CONFIG_ROOT = path.join(root, "config");
  process.env.TOKTRACKER_BIN_DIR = path.join(root, "bin");
  return root;
};

const createArchive = async (
  root: string,
  role: "client" | "gateway",
  version: string
): Promise<string> => {
  const packageRoot = path.join(root, "archive", "package");
  const dist = path.join(packageRoot, "apps", role, "dist");
  await mkdir(dist, { recursive: true });
  await Bun.write(path.join(dist, "cli.js"), "console.log('cli');\n");
  await Bun.write(path.join(dist, "index.js"), "console.log('service');\n");
  await Bun.write(
    path.join(packageRoot, "release.json"),
    `${JSON.stringify({ repository: "example/repository", role, version })}\n`
  );
  const archive = path.join(root, `${role}-${version}.tgz`);
  const result = Bun.spawnSync([
    "tar",
    "-czf",
    archive,
    "-C",
    path.dirname(packageRoot),
    "package",
  ]);
  if (result.exitCode !== 0) {
    throw new Error("Could not create test archive");
  }
  return archive;
};

afterEach(async () => {
  delete process.env.TOKTRACKER_CONFIG_ROOT;
  delete process.env.TOKTRACKER_BIN_DIR;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("versioned installations", () => {
  test("extracts releases and atomically records activation history", async () => {
    const root = await createRoot();
    const firstArchive = await createArchive(root, "client", "v1.0.0");
    const secondArchive = await createArchive(root, "client", "v1.1.0");

    await extractVersionArchive("client", "v1.0.0", firstArchive);
    await extractVersionArchive("client", "v1.1.0", secondArchive);
    await activateVersion("client", "v1.0.0");
    await activateVersion("client", "v1.1.0");

    expect(await installedVersions("client")).toEqual(["v1.0.0", "v1.1.0"]);
    expect(await readActiveInstallation("client")).toEqual({
      previousVersion: "v1.0.0",
      version: "v1.1.0",
    });
  });

  test("rejects a release for a different role", async () => {
    const root = await createRoot();
    const archive = await createArchive(root, "gateway", "v1.0.0");

    expect(extractVersionArchive("client", "v1.0.0", archive)).rejects.toThrow(
      "manifest does not match"
    );
  });

  test("writes a stable launcher and command shim", async () => {
    const root = await createRoot();
    const archive = await createArchive(root, "client", "v1.0.0");
    await extractVersionArchive("client", "v1.0.0", archive);
    await activateVersion("client", "v1.0.0");

    const launcher = await ensureLauncher("client");
    const shim = path.join(root, "bin", "toktracker-client");

    expect(await Bun.file(launcher).text()).toContain("active.version");
    expect(await Bun.file(shim).text()).toContain("launcher-client.js");
  });
});
