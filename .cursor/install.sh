#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for TokTracker.
# Installs the pinned Bun toolchain, makes it (and a Node new enough for the
# Oxlint/Oxfmt TypeScript config loaders) resolve in the agent's login shells,
# and refreshes workspace dependencies.
set -euo pipefail

BUN_VERSION="1.3.12"
# Minimum Node that can load the repo's oxlint.config.ts / oxfmt.config.ts.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=18

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# 1. Install the pinned Bun toolchain when missing or on the wrong version.
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

# 2. Ensure `node` resolves to >= 22.18.
# The pod injects an older Node at /exec-daemon that precedes nvm's Node in PATH
# and is not writable. Prepending ~/.bun/bin (step 3) lets a symlink there win.
node_major_minor() {
  "$1" -p 'const v = process.versions.node.split("."); `${v[0]} ${v[1]}`' 2>/dev/null || echo "0 0"
}
node_is_new_enough() {
  local maj min
  read -r maj min <<<"$(node_major_minor "$1")"
  [ "$maj" -gt "$NODE_MIN_MAJOR" ] || { [ "$maj" -eq "$NODE_MIN_MAJOR" ] && [ "$min" -ge "$NODE_MIN_MINOR" ]; }
}

newest_node=""
for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$candidate" ] || continue
  if node_is_new_enough "$candidate"; then
    newest_node="$candidate"
  fi
done
if [ -n "$newest_node" ]; then
  mkdir -p "$BUN_INSTALL/bin"
  ln -sf "$newest_node" "$BUN_INSTALL/bin/node"
  echo "Linked node -> $newest_node"
elif ! { command -v node >/dev/null 2>&1 && node_is_new_enough "$(command -v node)"; }; then
  echo "WARNING: no Node >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} found; 'bun run check'/'fix' may fail to load TS configs." >&2
fi

# 3. Make the toolchain resolve by default in the agent's login shells.
# Bun's own installer does not reliably persist this into the built environment,
# and ~/.bun/bin must precede the pod's injected /exec-daemon Node, so manage an
# explicit block in ~/.bashrc (mirroring how nvm is set up there).
bashrc="$HOME/.bashrc"
marker_begin="# >>> toktracker cloud agent (managed) >>>"
marker_end="# <<< toktracker cloud agent (managed) <<<"
if [ ! -f "$bashrc" ] || ! grep -qF "$marker_begin" "$bashrc"; then
  {
    printf '%s\n' "$marker_begin"
    printf '%s\n' 'export BUN_INSTALL="$HOME/.bun"'
    printf '%s\n' 'export PATH="$BUN_INSTALL/bin:$PATH"'
    printf '%s\n' "$marker_end"
  } >>"$bashrc"
  echo "Added Bun PATH block to $bashrc"
fi

# 4. Refresh workspace dependencies.
bun install
