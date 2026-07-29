#!/usr/bin/env sh
set -eu

ROLE="client"
CHANNEL="stable"
REPOSITORY="${TOKTRACKER_REPOSITORY:-brrock/toktracker}"
if [ "${1:-}" = "--nightly" ]; then CHANNEL="nightly"; fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required. Install it from https://bun.sh and run this installer again." >&2
  exit 1
fi
if [ "$CHANNEL" = "stable" ]; then
  RELEASE_URL="https://api.github.com/repos/$REPOSITORY/releases/latest"
else
  RELEASE_URL="https://api.github.com/repos/$REPOSITORY/releases?per_page=30"
fi
ASSET_DATA="$(bun -e '
const [url, channel, role] = process.argv.slice(1);
const response = await fetch(url, { headers: { "user-agent": "TokTracker installer" } });
if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
const value = await response.json();
const release = channel === "nightly" ? value.find((item) => item.prerelease && item.tag_name.startsWith("nightly-")) : value;
if (!release) throw new Error("No matching release found");
const name = `toktracker-${role}-${release.tag_name}.tgz`;
const asset = release.assets.find((item) => item.name === name);
const checksum = release.assets.find((item) => item.name === `${name}.sha256`);
if (!asset || !checksum) throw new Error("Release archive or checksum not found");
process.stdout.write(`${asset.browser_download_url}|${checksum.browser_download_url}|${release.tag_name}`);
' "$RELEASE_URL" "$CHANNEL" "$ROLE")"
ASSET_URL="${ASSET_DATA%%|*}"
REMAINDER="${ASSET_DATA#*|}"
CHECKSUM_URL="${REMAINDER%%|*}"
VERSION="${REMAINDER#*|}"

TEMPORARY="$(mktemp -d)"
trap 'rm -rf "$TEMPORARY"' EXIT
ARCHIVE="$TEMPORARY/${ASSET_URL##*/}"
curl --fail --location "$ASSET_URL" --output "$ARCHIVE"
curl --fail --location "$CHECKSUM_URL" --output "$ARCHIVE.sha256"
bun -e '
const [archive, checksumFile] = process.argv.slice(1);
const expected = (await Bun.file(checksumFile).text()).trim().split(/\s+/)[0];
const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
if (!expected || actual !== expected.toLowerCase()) throw new Error("Release checksum verification failed");
' "$ARCHIVE" "$ARCHIVE.sha256"
CLI_PATH="$(bun -e '
import { homedir, platform } from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
const [archive, role, version] = process.argv.slice(1);
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version)) throw new Error("Invalid release version");
const home = homedir();
const root = process.env.TOKTRACKER_CONFIG_ROOT ?? (platform() === "darwin" ? path.join(home, "Library", "Application Support", "TokTracker") : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "toktracker"));
const versions = path.join(root, "installs", role, "versions");
const destination = path.join(versions, version);
if (!(await Bun.file(path.join(destination, "release.json")).exists())) {
  const listing = Bun.spawnSync(["tar", "-tzf", archive]);
  if (listing.exitCode !== 0) throw new Error("Could not inspect release archive");
  for (const entry of new TextDecoder().decode(listing.stdout).split(/\r?\n/).filter(Boolean)) {
    const parts = entry.replace(/\/$/, "").split("/");
    if (parts[0] !== "package" || parts.some((part) => part === "." || part === ".." || part.includes("\\"))) throw new Error(`Unsafe archive path: ${entry}`);
  }
  await mkdir(versions, { recursive: true });
  const staging = await mkdtemp(path.join(versions, `.staging-${version}-`));
  const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", staging, "--strip-components=1"]);
  if (extracted.exitCode !== 0) { await rm(staging, { recursive: true, force: true }); throw new Error("Could not extract release archive"); }
  const manifest = await Bun.file(path.join(staging, "release.json")).json();
  if (manifest.role !== role || manifest.version !== version || !(await Bun.file(path.join(staging, "apps", role, "dist", "cli.js")).exists())) { await rm(staging, { recursive: true, force: true }); throw new Error("Release contents do not match"); }
  await rename(staging, destination);
}
const installedManifest = await Bun.file(path.join(destination, "release.json")).json();
if (installedManifest.role !== role || installedManifest.version !== version || !(await Bun.file(path.join(destination, "apps", role, "dist", "cli.js")).exists()) || !(await Bun.file(path.join(destination, "apps", role, "dist", "index.js")).exists())) throw new Error("Installed release contents do not match");
const activePath = path.join(root, "installs", role, "active.json");
let previousVersion;
try { previousVersion = (await Bun.file(activePath).json()).version; } catch {}
await mkdir(path.dirname(activePath), { recursive: true });
const temporaryActive = `${activePath}.${crypto.randomUUID()}`;
await Bun.write(temporaryActive, `${JSON.stringify({ version, previousVersion }, null, 2)}\n`);
await rename(temporaryActive, activePath);
process.stdout.write(path.join(destination, "apps", role, "dist", "cli.js"));
' "$ARCHIVE" "$ROLE" "$VERSION")"

# When invoked as `curl ... | bash`, stdin is the downloaded script rather than
# the terminal. Give the setup CLI the controlling terminal for its prompts.
if [ ! -r /dev/tty ]; then
  echo "An interactive terminal is required to configure TokTracker." >&2
  exit 1
fi
bun "$CLI_PATH" complete-install </dev/tty
