import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type ServiceRole = "client" | "gateway";

const [roleValue, releaseVersion, repository, outputValue] =
  process.argv.slice(2);
if (
  (roleValue !== "client" && roleValue !== "gateway") ||
  !releaseVersion ||
  !repository ||
  !outputValue
) {
  throw new Error(
    "Usage: bun scripts/package-release.ts <client|gateway> <version> <owner/repository> <output.tgz>"
  );
}
const role: ServiceRole = roleValue;
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(outputValue);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "toktracker-package-"));
const packageRoot = path.join(temporaryRoot, "package");
try {
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.join(packageRoot, "apps", role), { recursive: true });
  await cp(
    path.join(root, "apps", role, "dist"),
    path.join(packageRoot, "apps", role, "dist"),
    { recursive: true }
  );
  if (
    role === "gateway" &&
    !(await Bun.file(
      path.join(
        packageRoot,
        "apps",
        "gateway",
        "dist",
        "dashboard",
        "index.html"
      )
    ).exists())
  ) {
    throw new Error("Gateway build does not contain the dashboard");
  }
  const packageVersion = releaseVersion.startsWith("v")
    ? releaseVersion.slice(1)
    : `0.0.0-${releaseVersion.replaceAll(/[^a-zA-Z0-9.-]/gu, ".")}`;
  await Bun.write(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      {
        bin: {
          [`toktracker-${role}`]: `apps/${role}/dist/cli.js`,
        },
        name: `@toktracker/${role}-cli`,
        type: "module",
        version: packageVersion,
      },
      null,
      2
    )
  );
  await Bun.write(
    path.join(packageRoot, "release.json"),
    JSON.stringify({ repository, role, version: releaseVersion }, null, 2)
  );
  const archive = Bun.spawnSync([
    "tar",
    "-czf",
    output,
    "-C",
    temporaryRoot,
    "package",
  ]);
  if (archive.exitCode !== 0) {
    throw new Error("Could not create release archive");
  }
  console.log(`Created ${output}`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
