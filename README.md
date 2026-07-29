# TokTracker

https://github.com/user-attachments/assets/62910d7c-d7c3-4211-907e-f88c7b5948fc

**TokTracker is a self-hosted, local-first dashboard for AI coding-agent usage.** It reads the session data already on your machines, estimates or preserves reported costs, and sends the results to a gateway you control.

Run one **gateway** where you want to view the dashboard, then run a lightweight **client** on each computer you want to track.

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
| Pi             | JSONL sessions                                            |
| OpenCode       | Legacy JSON and SQLite v1/v2                              |
| Hermes Agent   | SQLite                                                    |
| GitHub Copilot | OTEL/CLI JSONL, Desktop SQLite, and VS Code chat sessions |

TokTracker only scans these local agent-data locations. It does not proxy requests to model providers or inspect your editor in real time.

## Quick start from source

**Requirements:** [Bun](https://bun.sh) 1.3.12 or newer.

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

Development data is kept in `.dev-data/` and is ignored by Git. Start over with:

```bash
TOKTRACKER_DEV_RESET=1 bun run dev
```

### Demo dashboard

To explore the dashboard without local agent sessions, start a self-contained demo with generated mock usage, projects, sessions, and devices:

```bash
bun run demo
```

Open **http://localhost:5174** and enter the pairing code printed by the demo command. The demo uses ports `5174` (dashboard) and `4311` (gateway), stores data in `.demo-data/`, and resets that data every time it starts. Override the ports with `TOKTRACKER_DEMO_DASHBOARD_PORT` and `TOKTRACKER_DEMO_GATEWAY_PORT`.

## Install for everyday use

Install the gateway first, then install the client on every computer whose sessions you want to include. Release installers need Bun and download releases from [`brrock/toktracker`](https://github.com/brrock/toktracker).

### 1. Set up the gateway

Run the matching installer directly:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/brrock/toktracker/main/install-gateway.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/brrock/toktracker/main/install-gateway.ps1 | iex
```

The installer verifies the release checksum, extracts a versioned `toktracker-gateway` installation, and launches its interactive setup. Setup lets you choose a port (default `3000`) and installs a background service. The gateway listens only on `127.0.0.1` by default.

LAN access is an explicit setup choice and always generates or requires a shared ingestion key. When enabled, setup prints LAN addresses and a warning about firewalling the port. Keep the printed key—you will need it when setting up clients.

The dashboard uses per-device pairing instead of the ingestion key. On the gateway, run `toktracker-gateway auth code`, open the dashboard, and enter the one-time code. The browser remains signed in through automatically rotated, HttpOnly session cookies.

### 2. Set up a client

On each machine with coding-agent sessions, run the matching client installer:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/brrock/toktracker/main/install-client.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/brrock/toktracker/main/install-client.ps1 | iex
```

Client setup asks for the gateway URL and shared key (leave it blank when the gateway has no key), then verifies `/api/health`. It then installs a background service that scans and uploads changed sessions.

To use prereleases, add `--nightly` on macOS/Linux or `-Nightly` in PowerShell.

### Migrating an existing global installation

Run the current client or gateway install script once instead of using the legacy `update` command. The installer copies the existing Bun-global release unchanged into `installs/<role>/versions/<old-version>`, installs the new release beside it, and records the old release as the rollback target. Configuration and data remain in place.

The updater shipped in `v0.0.1` removes its global package before installing an update, so it cannot preserve itself; the one-time transition must be started with the current install script. After migration, normal `update`, `use`, and `rollback` commands use the versioned installation store.

### Source checkout setup

From a checkout, use the same interactive setup without installing a release archive:

```bash
bun run setup:gateway
bun run setup:client
```

You can run configured services manually with:

```bash
bun run start:gateway
bun run start:client
```

## Configuration and updates

Each role has its own CLI. `config` lists supported fields; encryption keys are masked in its output.

```bash
# See configuration and its file location
toktracker-gateway config
toktracker-client config path

# Change settings (restarts the role unless --no-restart is used)
toktracker-gateway config set port 4310
toktracker-client config set gateway-url http://server:3000
toktracker-client config set interval-ms 120000
toktracker-client config unset encryption-key

# Update, downgrade, or choose an update channel
toktracker-gateway update
toktracker-client update --nightly
toktracker-client update --version v0.1.0
toktracker-client versions
toktracker-client use v0.1.0
toktracker-client rollback
toktracker-client channel nightly
```

A client validates a new gateway URL before saving it. Use `--skip-check` only when the gateway is temporarily unavailable.

### Files on disk

| Platform | Configuration | Data |
| --- | --- | --- |
| Linux | `~/.config/toktracker` | `~/.local/share/toktracker` |
| macOS | `~/Library/Application Support/TokTracker` | `~/Library/Application Support/TokTracker` |
| Windows | `%APPDATA%\TokTracker` | `%LOCALAPPDATA%\TokTracker` |

Release installers extract each release under `installs/<role>/versions/<version>` in the configuration directory. A stable launcher selects the version recorded in `active.json`, so updates switch versions atomically and restore the previous version when startup verification fails. Installed versions remain available for explicit downgrades and `rollback`.

The client keeps its scan index and cached pricing data locally. The gateway stores its SQLite database in its data directory.

## Security and networking

A shared ingestion key encrypts **client ingestion payloads** with AES-256-GCM and authorizes only client health checks and ingestion. Dashboard users never receive that key. Each browser pairs once with a short-lived, single-use code and receives rotating access and refresh credentials in HttpOnly, SameSite cookies.

Manage paired dashboard devices from the gateway:

```bash
toktracker-gateway auth code                 # Create a 10-minute pairing code
toktracker-gateway auth devices              # List paired browsers
toktracker-gateway auth revoke <device-id>   # Sign out one browser
```

The gateway listens on `127.0.0.1` by default. Binding `HOST` to a non-loopback address requires `TOKTRACKER_API_KEY`; setup makes this an explicit LAN-access choice and prints a warning. HTTPS and firewall restrictions are still strongly recommended outside a trusted private network. Cross-origin API access is disabled by default; set `TOKTRACKER_CORS_ORIGIN` to one exact trusted origin when needed.

## How syncing works

The client scans supported session stores on a schedule (default: once per minute). It avoids re-uploading unchanged data:

- SQLite-backed sources are fingerprinted per session; new or changed sessions are patched and deleted sessions are removed.
- JSON and JSONL sources use source-level replacement, so a changed source is uploaded as its current complete view.
- Pricing catalogs are cached locally for 24 hours. Set `TOKTRACKER_DISABLE_PRICING=1` to disable pricing lookups.

Useful runtime environment variables include `TOKTRACKER_GATEWAY`, `TOKTRACKER_API_KEY`, `TOKTRACKER_INTERVAL_MS`, `TOKTRACKER_DATA_DIR`, `TOKTRACKER_DB`, `TOKTRACKER_CORS_ORIGIN`, `PORT`, and `HOST`.

## Development

```bash
bun run build       # Build dashboard, gateway, and client
bun test            # Run tests
bun run typecheck   # Type-check all workspaces
bun run check       # Lint and format check
bun run fix         # Apply formatting and safe fixes
```

### Workspace layout

```text
apps/client      Local scanner and uploader
apps/gateway     Hono API, SQLite store, and production dashboard host
apps/dashboard   React/Vite dashboard
packages/cli     Setup, service, configuration, and update commands
packages/shared  API contracts and payload encryption
packages/token-calc  Session parsers, aggregation, and pricing
```
