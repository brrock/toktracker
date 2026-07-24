/* eslint-disable func-style, no-await-in-loop, no-empty, no-nested-ternary, promise/prefer-await-to-then, require-unicode-regexp, sort-vars, typescript/no-non-null-assertion, unicorn/import-style */
// Source scans are deliberately sequential to bound memory and open-file usage.
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { join, dirname } from "node:path";

import { encryptPayload } from "@toktracker/shared";
import type {
  IngestRequest,
  SessionSnapshot,
  UsageMessage,
} from "@toktracker/shared";
import type { PriceCatalog } from "@toktracker/token-calc";
import {
  applyEstimatedPricing,
  parseClaude,
  parseCodex,
  parseCopilotDesktopSqlite,
  parseCopilotOtel,
  parseCopilotVsCode,
  parseHermesSqlite,
  parseLiteLlmCatalog,
  parseOpenCodeJson,
  parseOpenCodeSqlite,
  parsePi,
  parseModelsDevCatalog,
} from "@toktracker/token-calc";

const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
const dataDir = process.env.TOKTRACKER_DATA_DIR ?? join(home, ".toktracker");
await mkdir(dataDir, { recursive: true });
const PRICING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INDEX_SCHEMA_VERSION = 3;

const cleanSessionTitle = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const title = value.replaceAll(/\s+/gu, " ").trim();
  return title ? title.slice(0, 160) : undefined;
};

async function loadSessionTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const addHistory = async (
    path: string,
    idField: string,
    titleField: string
  ) => {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return;
    }
    const contents = await file.text();
    for (const line of contents.split(/\r?\n/u)) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const id = row[idField];
        const title = cleanSessionTitle(row[titleField]);
        if (typeof id === "string" && title && !titles.has(id)) {
          titles.set(id, title);
        }
      } catch {}
    }
  };
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
  await Promise.all([
    addHistory(join(claudeHome, "history.jsonl"), "sessionId", "display"),
    addHistory(join(codexHome, "history.jsonl"), "session_id", "text"),
  ]);
  const codexState = join(codexHome, "state_5.sqlite");
  if (await Bun.file(codexState).exists()) {
    try {
      const state = new Database(codexState, { readonly: true });
      const rows = state
        .query("SELECT id,name,title,first_user_message FROM threads")
        .all() as Record<string, unknown>[];
      state.close();
      for (const row of rows) {
        const { id } = row;
        const title =
          cleanSessionTitle(row.name) ??
          cleanSessionTitle(row.title) ??
          cleanSessionTitle(row.first_user_message);
        if (typeof id === "string" && title) {
          titles.set(id, title);
        }
      }
    } catch {}
  }
  return titles;
}

async function loadPricingSource(
  cacheName: string,
  url: string,
  parseCatalog: (value: unknown) => PriceCatalog
): Promise<PriceCatalog> {
  const cacheFile = Bun.file(join(dataDir, cacheName));
  const hasCache = await cacheFile.exists();
  if (hasCache) {
    const cacheStat = await cacheFile.stat();
    if (Date.now() - cacheStat.mtimeMs < PRICING_CACHE_MAX_AGE_MS) {
      return parseCatalog(await cacheFile.json());
    }
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Pricing source returned ${response.status}`);
    }
    const rawCatalog: unknown = await response.json();
    await Bun.write(cacheFile, JSON.stringify(rawCatalog));
    return parseCatalog(rawCatalog);
  } catch {
    return hasCache ? parseCatalog(await cacheFile.json()) : {};
  }
}

async function loadPricingCatalog(): Promise<PriceCatalog> {
  const [liteLlm, modelsDev] = await Promise.all([
    loadPricingSource(
      "pricing-litellm.json",
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      parseLiteLlmCatalog
    ),
    loadPricingSource(
      "pricing-models-dev.json",
      "https://models.dev/api.json",
      parseModelsDevCatalog
    ),
  ]);
  return { ...modelsDev, ...liteLlm };
}

const [pricingCatalog, sessionTitles] = await Promise.all([
  process.env.TOKTRACKER_DISABLE_PRICING === "1" ? {} : loadPricingCatalog(),
  loadSessionTitles(),
]);
const db = new Database(join(dataDir, "client.db"), { create: true });
db.exec(
  "CREATE TABLE IF NOT EXISTS indexed_files(path TEXT PRIMARY KEY,mtime_ms REAL NOT NULL,size INTEGER NOT NULL,uploaded_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS indexed_sessions(source_path TEXT NOT NULL,session_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(source_path,session_id));CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)"
);
const indexVersion = Bun.hash(
  JSON.stringify([INDEX_SCHEMA_VERSION, pricingCatalog, [...sessionTitles]])
).toString(16);
const previousIndexVersion = (
  db.query("SELECT value FROM settings WHERE key='index_version'").get() as {
    value: string;
  } | null
)?.value;
if (previousIndexVersion !== indexVersion) {
  db.exec("DELETE FROM indexed_files");
  db.query(
    "INSERT INTO settings(key,value) VALUES('index_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(indexVersion);
}
let deviceId = (
  db.query("SELECT value FROM settings WHERE key='device_id'").get() as {
    value: string;
  } | null
)?.value;
if (!deviceId) {
  deviceId = crypto.randomUUID();
  db.query("INSERT INTO settings(key,value) VALUES('device_id',?)").run(
    deviceId
  );
}

interface Source {
  path: string;
  kind: string;
  companion?: string;
}
async function discover(): Promise<Source[]> {
  const sources: Source[] = [],
    seen = new Set<string>();
  const add = (s: Source) => {
    if (!seen.has(s.path)) {
      seen.add(s.path);
      sources.push(s);
    }
  };
  const scan = async (root: string, pattern: string, kind: string) => {
    const glob = new Bun.Glob(pattern);
    try {
      for await (const path of glob.scan({
        absolute: true,
        cwd: root,
        onlyFiles: true,
      })) {
        add({ kind, path });
      }
    } catch {}
  };
  const claude = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  await scan(join(claude, "projects"), "**/*.jsonl", "claude");
  const codex = process.env.CODEX_HOME ?? join(home, ".codex");
  await scan(join(codex, "sessions"), "**/*.jsonl", "codex");
  await scan(join(codex, "archived_sessions"), "**/*.jsonl", "codex");
  await scan(join(home, ".pi", "agent", "sessions"), "**/*.jsonl", "pi");
  await scan(join(home, ".omp", "agent", "sessions"), "**/*.jsonl", "pi");
  const oc =
    process.env.OPENCODE_DATA_DIR ?? join(home, ".local", "share", "opencode");
  await scan(join(oc, "storage", "message"), "**/*.json", "opencode-json");
  await scan(oc, "opencode*.db", "opencode-sqlite");
  const hermes = process.env.HERMES_HOME ?? join(home, ".hermes");
  await scan(hermes, "state.db", "hermes");
  await scan(join(hermes, "profiles"), "*/state.db", "hermes");
  const copilot = join(home, ".copilot");
  await scan(join(copilot, "otel"), "**/*.jsonl", "copilot-otel");
  await scan(copilot, "data.db", "copilot-desktop");
  const vscodeRoots =
    platform() === "darwin"
      ? [
          join(
            home,
            "Library",
            "Application Support",
            "Code",
            "User",
            "workspaceStorage"
          ),
        ]
      : platform() === "win32"
        ? [
            join(
              process.env.APPDATA ?? join(home, "AppData", "Roaming"),
              "Code",
              "User",
              "workspaceStorage"
            ),
          ]
        : [join(home, ".config", "Code", "User", "workspaceStorage")];
  for (const root of vscodeRoots) {
    const glob = new Bun.Glob("*/chatSessions/*.jsonl");
    try {
      for await (const path of glob.scan({
        absolute: true,
        cwd: root,
        onlyFiles: true,
      })) {
        add({
          companion: join(dirname(dirname(path)), "workspace.json"),
          kind: "copilot-vscode",
          path,
        });
      }
    } catch {}
  }
  if (process.env.COPILOT_OTEL_EXPORTER_FILE) {
    add({ kind: "copilot-otel", path: process.env.COPILOT_OTEL_EXPORTER_FILE });
  }
  return sources;
}
async function fingerprint(path: string, companion?: string) {
  const stat = await Bun.file(path).stat();
  let mtime = stat.mtimeMs,
    { size } = stat;
  for (const related of [`${path}-wal`, `${path}-shm`, companion].filter(
    Boolean
  ) as string[]) {
    const file = Bun.file(related);
    if (await file.exists()) {
      const s = await file.stat();
      mtime = Math.max(mtime, s.mtimeMs);
      size += s.size;
    }
  }
  return { mtime, size };
}
async function parseUnpriced(
  source: Source,
  mtime: number
): Promise<UsageMessage[]> {
  if (source.kind === "opencode-sqlite") {
    return parseOpenCodeSqlite(source.path);
  }
  if (source.kind === "hermes") {
    return parseHermesSqlite(source.path);
  }
  if (source.kind === "copilot-desktop") {
    const events: Record<string, string> = {};
    const glob = new Bun.Glob("*/events.jsonl");
    try {
      for await (const path of glob.scan({
        absolute: true,
        cwd: join(dirname(source.path), "session-state"),
        onlyFiles: true,
      })) {
        events[dirname(path).split(/[\\/]/).pop()!] =
          await Bun.file(path).text();
      }
    } catch {}
    return parseCopilotDesktopSqlite(source.path, events);
  }
  const text = await Bun.file(source.path).text();
  switch (source.kind) {
    case "claude": {
      return parseClaude(text, source.path, mtime);
    }
    case "codex": {
      return parseCodex(text, source.path, mtime);
    }
    case "pi": {
      return parsePi(text, source.path, mtime);
    }
    case "opencode-json": {
      return parseOpenCodeJson(text, source.path);
    }
    case "copilot-otel": {
      return parseCopilotOtel(text, source.path, mtime);
    }
    case "copilot-vscode": {
      let uri: string | undefined;
      try {
        const workspace = JSON.parse(await Bun.file(source.companion!).text());
        uri = workspace.folder ?? workspace.workspace;
      } catch {}
      return parseCopilotVsCode(text, source.path, uri);
    }
    default: {
      return [];
    }
  }
}

async function parse(source: Source, mtime: number): Promise<UsageMessage[]> {
  const unpricedMessages = await parseUnpriced(source, mtime);
  const messages = unpricedMessages.map((message) => ({
    ...message,
    sessionTitle: sessionTitles.get(message.sessionId) ?? message.sessionTitle,
  }));
  return applyEstimatedPricing(messages, pricingCatalog);
}

interface ScanState {
  sourcePath: string;
  mtime: number;
  size: number;
  hashes: Map<string, string>;
}
interface SyncPlan {
  sessions: SessionSnapshot[];
  sourceUpdates: NonNullable<IngestRequest["sourceUpdates"]>;
  scans: ScanState[];
}
const sqliteKinds = new Set(["opencode-sqlite", "hermes", "copilot-desktop"]);
const sessionHash = (messages: UsageMessage[]) =>
  Bun.hash(JSON.stringify(messages)).toString(16);

async function changedSessions(): Promise<SyncPlan> {
  const plan: SyncPlan = { scans: [], sessions: [], sourceUpdates: [] };
  for (const source of await discover()) {
    try {
      const fp = await fingerprint(source.path, source.companion);
      const known = db
        .query("SELECT mtime_ms,size FROM indexed_files WHERE path=?")
        .get(source.path) as { mtime_ms: number; size: number } | null;
      if (known && known.mtime_ms === fp.mtime && known.size === fp.size) {
        continue;
      }
      const messages = await parse(source, fp.mtime);
      const grouped = new Map<string, UsageMessage[]>();
      for (const message of messages) {
        grouped.set(message.sessionId, [
          ...(grouped.get(message.sessionId) ?? []),
          message,
        ]);
      }
      const hashes = new Map(
        [...grouped].map(([id, list]) => [id, sessionHash(list)])
      );
      const previousRows = db
        .query(
          "SELECT session_id,content_hash FROM indexed_sessions WHERE source_path=?"
        )
        .all(source.path) as { session_id: string; content_hash: string }[];
      const previous = new Map(
        previousRows.map((row) => [row.session_id, row.content_hash])
      );
      const incremental = sqliteKinds.has(source.kind);
      const removed = incremental
        ? [...previous.keys()].filter((id) => !hashes.has(id))
        : [];
      plan.sourceUpdates.push({
        mode: incremental ? "patch" : "replace",
        removedSessionIds: removed,
        sourcePath: source.path,
      });
      for (const [sessionId, list] of grouped) {
        if (incremental && previous.get(sessionId) === hashes.get(sessionId)) {
          continue;
        }
        plan.sessions.push({
          deviceId: deviceId!,
          messages: list,
          project: list[0]?.workspaceLabel,
          sessionId,
          sourceMtimeMs: fp.mtime,
          sourcePath: source.path,
          sourceSize: fp.size,
        });
      }
      plan.scans.push({
        hashes,
        mtime: fp.mtime,
        size: fp.size,
        sourcePath: source.path,
      });
    } catch (error) {
      console.warn(`TokTracker: failed to parse ${source.path}`, error);
    }
  }
  return plan;
}

function commit(plan: SyncPlan) {
  const mark = db.query(
    "INSERT INTO indexed_files(path,mtime_ms,size,uploaded_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms,size=excluded.size,uploaded_at=excluded.uploaded_at"
  );
  const putHash = db.query(
    "INSERT INTO indexed_sessions(source_path,session_id,content_hash) VALUES(?,?,?)"
  );
  db.transaction(() => {
    for (const scan of plan.scans) {
      mark.run(scan.sourcePath, scan.mtime, scan.size, Date.now());
      db.query("DELETE FROM indexed_sessions WHERE source_path=?").run(
        scan.sourcePath
      );
      for (const [id, hash] of scan.hashes) {
        putHash.run(scan.sourcePath, id, hash);
      }
    }
  })();
}

async function sync() {
  const plan = await changedSessions();
  const mustContactGateway =
    plan.sessions.length > 0 ||
    plan.sourceUpdates.some(
      (update) =>
        update.mode === "replace" || (update.removedSessionIds?.length ?? 0) > 0
    );
  if (!mustContactGateway) {
    commit(plan);
    console.log("TokTracker: no changed sessions");
    return;
  }
  const payload: IngestRequest = {
    device: {
      id: deviceId!,
      name: process.env.TOKTRACKER_DEVICE_NAME ?? hostname(),
      platform: platform(),
    },
    sessions: plan.sessions,
    sourceUpdates: plan.sourceUpdates,
  };
  const endpoint = process.env.TOKTRACKER_GATEWAY ?? "http://localhost:3000";
  const accessKey = process.env.TOKTRACKER_API_KEY;
  const requestBody = accessKey
    ? await encryptPayload(payload, accessKey)
    : payload;
  const response = await fetch(`${endpoint}/api/v1/ingest`, {
    body: JSON.stringify(requestBody),
    headers: {
      "content-type": "application/json",
      ...(accessKey ? { authorization: `Bearer ${accessKey}` } : {}),
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Gateway rejected upload: ${response.status} ${await response.text()}`
    );
  }
  commit(plan);
  console.log(
    `TokTracker: uploaded ${plan.sessions.length} changed session(s)`
  );
}
await sync();
const interval = Number(process.env.TOKTRACKER_INTERVAL_MS ?? 60_000);
if (process.env.TOKTRACKER_ONCE !== "1") {
  setInterval(() => sync().catch(console.error), interval);
}
