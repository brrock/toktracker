# TokTracker

https://github.com/user-attachments/assets/62910d7c-d7c3-4211-907e-f88c7b5948fc

**TokTracker is a self-hosted, local-first dashboard for AI coding-agent usage.** It reads session data already on your machines, estimates or preserves reported costs, and sends the results to a gateway you control.

Run one **gateway** where you want the dashboard, then run a lightweight **client** on each computer you want to track.

## Install

**Requirement:** [Bun](https://bun.sh) 1.3.12 or newer. Release installers download from [`brrock/toktracker`](https://github.com/brrock/toktracker).

### 1. Install the gateway

Run one installer on the machine that will host the dashboard:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/brrock/toktracker/main/install-gateway.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/brrock/toktracker/main/install-gateway.ps1 | iex
```

The installer verifies the release checksum, extracts a versioned `toktracker-gateway` installation, and starts interactive setup. Choose a port (default `3000`), optionally set an ingestion key, then choose LAN access and either all interfaces or one specific bind address.

The gateway listens on `127.0.0.1` by default. LAN access is an explicit setup choice; it generates or requires a shared ingestion key. Keep that key for client setup, firewall the port, and use HTTPS outside a trusted private network.

### 2. Open and pair the dashboard

On the gateway machine, generate a one-time pairing code:

```bash
toktracker-gateway auth code
```

Open the dashboard URL printed during setup and enter the code. The dashboard uses per-device pairing—not the ingestion key—and stays signed in through automatically rotated, HttpOnly session cookies.

### 3. Install a client on every tracked computer

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/brrock/toktracker/main/install-client.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/brrock/toktracker/main/install-client.ps1 | iex
```

Client setup asks for the gateway URL and shared key. Leave the key blank when the gateway has no key. It verifies `/api/health`, then installs a background service to scan and upload changed sessions.

For prereleases, add `--nightly` on macOS/Linux or `-Nightly` in PowerShell.

## What it tracks

- Tokens, cost, models, agents, projects, sessions, and active devices
- Provider-reported cost where available, with estimated cost for the rest
- Historical sessions plus incremental updates as sessions change
- Multiple machines reporting to one gateway

### Supported sources

| Source         | Formats                                                   |
| -------------- | --------------------------------------------------------- |
| Claude Code    | JSONL sessions                                            |
| Codex          | JSONL sessions and local titles                           |
| Cursor IDE     | Usage CSV via desktop login (multi-account)               |
| Pi             | JSONL sessions                                            |
| OpenCode       | Legacy JSON and SQLite v1/v2                              |
| OpenClaw       | Agent JSONL transcripts                                   |
| Hermes Agent   | SQLite                                                    |
| GitHub Copilot | OTEL/CLI JSONL, Desktop SQLite, and VS Code chat sessions |

TokTracker scans these local agent-data locations. Cursor usage is the exception: the client reads the signed-in Cursor desktop session and exports usage CSV from Cursor's API for every saved account. It does not inspect your editor in real time.

## Configuration, updates, and pairing

Each role has its own CLI. `config` lists supported fields; encryption keys are masked in its output.

```bash
# See configuration and its file location
toktracker-gateway config
toktracker-client config path

# Change settings (restarts the role unless --no-restart is used)
toktracker-gateway config set port 4310
# Bind the gateway to a specific LAN, Tailscale, or other interface address.
# Pass only the address, not :port; the configured port is retained.
toktracker-gateway bind 100.78.66.1
toktracker-client config set gateway-url http://server:3000
toktracker-client config set interval-ms 120000
# Import Cursor usage for the signed-in desktop account (and any others you add)
toktracker-client cursor login --name work
toktracker-client cursor accounts
toktracker-client cursor sync --force
# Opt this client out of gateway-managed automatic updates.
toktracker-client config set gateway-auto-update 0
toktracker-client config unset encryption-key

# Update, downgrade, or choose an update channel
toktracker-gateway update
toktracker-client update --nightly
toktracker-client update --version v0.1.0
toktracker-client versions
toktracker-client use v0.1.0
toktracker-client rollback
toktracker-client channel nightly

# Manage dashboard access
toktracker-gateway auth code                 # Create a 10-minute pairing code
toktracker-gateway auth devices              # List paired browsers
toktracker-gateway auth revoke <device-id>   # Sign out one browser
```

A client validates a new gateway URL before saving it. Use `--skip-check` only when the gateway is temporarily unavailable.

### Gateway-managed automatic updates

In **Settings → General**, a gateway administrator can enable automatic client updates, choose the stable or nightly channel, and set a maintenance window (default 02:00–04:00). Each client evaluates that window in its own local time, checks at most once every 15 minutes, and updates at most once per day. The feature is off by default. Clients can always opt out locally with `toktracker-client config set gateway-auto-update 0`; setting it back to `1` opts in again.

### Migrating a legacy global installation

Run the current client or gateway install script once instead of the legacy `update` command. The installer copies the existing Bun-global release unchanged into `installs/<role>/versions/<old-version>`, installs the new release beside it, and records the old release as the rollback target. Configuration and data remain in place.

The updater shipped in `v0.0.1` removes its global package before installing an update, so it cannot preserve itself. After this one-time migration, normal `update`, `use`, and `rollback` commands use the versioned installation store.

## Security and networking

A shared ingestion key encrypts **client ingestion payloads** with AES-256-GCM and authorizes only client health checks and ingestion. Dashboard users never receive that key.

Binding `HOST` to a non-loopback address requires `TOKTRACKER_API_KEY`; setup makes this a LAN-access choice and prints a warning. Use `toktracker-gateway bind <IPv4-or-IPv6-address>` to bind to one specific address (for example, `100.78.66.1` or `192.168.0.77`); do not include a port. Cross-origin API access is disabled by default; set `TOKTRACKER_CORS_ORIGIN` to one exact trusted origin when needed.

## Data and syncing

The client scans supported session stores on a schedule (default: once per minute) and avoids re-uploading unchanged data:

- SQLite-backed sources are fingerprinted per session; new or changed sessions are patched and deleted sessions are removed.
- JSON and JSONL sources use source-level replacement, so a changed source is uploaded as its current complete view.
- Pricing catalogs are cached locally for 24 hours. Set `TOKTRACKER_DISABLE_PRICING=1` to disable pricing lookups.

Useful runtime environment variables: `TOKTRACKER_GATEWAY`, `TOKTRACKER_API_KEY`, `TOKTRACKER_INTERVAL_MS`, `TOKTRACKER_DATA_DIR`, `TOKTRACKER_DB`, `TOKTRACKER_CORS_ORIGIN`, `PORT`, and `HOST`.

### Files on disk

| Platform | Configuration | Data |
| --- | --- | --- |
| Linux | `~/.config/toktracker` | `~/.local/share/toktracker` |
| macOS | `~/Library/Application Support/TokTracker` | `~/Library/Application Support/TokTracker` |
| Windows | `%APPDATA%\TokTracker` | `%LOCALAPPDATA%\TokTracker` |

Release installers extract releases under `installs/<role>/versions/<version>` in the configuration directory. A stable launcher selects the version recorded in `active.json`, so updates switch versions atomically and restore the previous version when startup verification fails. Installed versions remain available for explicit downgrades and `rollback`.

The client keeps its scan index and cached pricing data locally. The gateway stores its SQLite database in its data directory.

## Develop from source

```bash
bun install
bun run dev
```

Open **http://localhost:5173**. Development mode starts all three pieces:

| Service   | Address               | Purpose                            |
| --------- | --------------------- | ---------------------------------- |
| Dashboard | http://localhost:5173 | Vite development UI                |
| Gateway   | http://localhost:4310 | API and local database             |
| Client    | —                     | Scans sessions and uploads changes |

Development data is stored in `.dev-data/` and ignored by Git. Reset it with:

```bash
TOKTRACKER_DEV_RESET=1 bun run dev
```

### Source checkout setup

From a checkout, run the interactive setup without installing a release archive:

```bash
bun run setup:gateway
bun run setup:client
```

Run configured services manually with:

```bash
bun run start:gateway
bun run start:client
```

### Demo dashboard

Start a self-contained dashboard with generated mock usage, projects, sessions, and devices:

```bash
bun run demo
```

Open **http://localhost:5174** and enter the pairing code printed by the command. The demo uses ports `5174` (dashboard) and `4311` (gateway), stores data in `.demo-data/`, and resets it on every start. Override the ports with `TOKTRACKER_DEMO_DASHBOARD_PORT` and `TOKTRACKER_DEMO_GATEWAY_PORT`.

### Development commands

```bash
bun run build       # Build dashboard, gateway, and client
bun test            # Run tests
bun run typecheck   # Type-check all workspaces
bun run check       # Lint and format check
bun run fix         # Apply formatting and safe fixes
```

### Workspace layout

```text
apps/client         Local scanner and uploader
apps/gateway        Hono API, SQLite store, and production dashboard host
apps/dashboard      React/Vite dashboard
packages/cli        Setup, service, configuration, and update commands
packages/shared     API contracts and payload encryption
packages/token-calc Session parsers, aggregation, and pricing
```
