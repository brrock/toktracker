#!/usr/bin/env sh
set -eu

ROLE="gateway"
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
ASSET_URL="$(bun -e '
const [url, channel, role] = process.argv.slice(1);
const response = await fetch(url, { headers: { "user-agent": "TokTracker installer" } });
if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
const value = await response.json();
const release = channel === "nightly" ? value.find((item) => item.prerelease && item.tag_name.startsWith("nightly-")) : value;
if (!release) throw new Error("No matching release found");
const asset = release.assets.find((item) => item.name === `toktracker-${role}-${release.tag_name}.tgz`);
if (!asset) throw new Error("Release archive not found");
process.stdout.write(asset.browser_download_url);
' "$RELEASE_URL" "$CHANNEL" "$ROLE")"

TEMPORARY="$(mktemp -d)"
trap 'rm -rf "$TEMPORARY"' EXIT
ARCHIVE="$TEMPORARY/${ASSET_URL##*/}"
curl --fail --location "$ASSET_URL" --output "$ARCHIVE"
# Bun cannot replace a globally installed local archive in place.
bun remove --global "@toktracker/${ROLE}-cli" || true
bun add --global "$ARCHIVE"

# When invoked as `curl ... | bash`, stdin is the downloaded script rather than
# the terminal. Give the setup CLI the controlling terminal for its prompts.
if [ ! -r /dev/tty ]; then
  echo "An interactive terminal is required to configure TokTracker." >&2
  exit 1
fi
toktracker-gateway setup </dev/tty
