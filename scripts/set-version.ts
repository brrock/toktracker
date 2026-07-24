/* eslint-disable no-await-in-loop */
// Version files are intentionally updated sequentially for deterministic output.
import path from "node:path";

const [releaseTag] = process.argv.slice(2);
if (!releaseTag) {
  throw new Error("Usage: bun scripts/set-version.ts <release-tag>");
}

const version = releaseTag.startsWith("v")
  ? releaseTag.slice(1)
  : `0.0.0-${releaseTag.replaceAll(/[^a-zA-Z0-9.-]/gu, ".")}`;
const root = path.resolve(import.meta.dirname, "..");
const packageFiles = [path.join(root, "package.json")];
const glob = new Bun.Glob("{apps,packages}/*/package.json");
for await (const packageFile of glob.scan({ absolute: true, cwd: root })) {
  packageFiles.push(packageFile);
}
for (const packageFile of packageFiles) {
  const packageJson = (await Bun.file(packageFile).json()) as Record<
    string,
    unknown
  >;
  packageJson.version = version;
  await Bun.write(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
}
console.log(`Set workspace package versions to ${version}`);
