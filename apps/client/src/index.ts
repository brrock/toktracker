/* eslint-disable func-style, no-await-in-loop, no-empty, no-nested-ternary, promise/prefer-await-to-then, require-unicode-regexp, sort-vars, typescript/no-non-null-assertion, unicorn/import-style */
// Source scans are deliberately sequential to bound memory and open-file usage.
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { join, dirname } from "node:path";

import { autoUpdateClient } from "@toktracker/cli/client";
import { encryptPayload, isIngestRequest } from "@toktracker/shared";
import type {
  IngestRequest,
  JsonValue,
  SessionSnapshot,
  UsageMessage,
} from "@toktracker/shared";
import type { PriceCatalog } from "@toktracker/token-calc";
import {
  applyEstimatedPricing,
  clampCursorSyncIntervalMs,
  DEFAULT_CURSOR_SYNC_INTERVAL_MS,
  importDesktopCursorAccounts,
  listCursorAccounts,
  listCursorUsageCsvFiles,
  parseClaude,
  parseCodex,
  parseCopilotDesktopSqlite,
  parseCopilotOtel,
  parseCopilotVsCode,
  parseCursorCsv,
  parseHermesSqlite,
  parseLiteLlmCatalog,
  parseModelsDevCatalog,
  parseOpenClaw,
  parseOpenCodeJson,
  parseOpenCodeSqlite,
  parsePi,
  readDesktopCursorSessions,
  removeCursorAccount,
  resolveCursorPaths,
  setActiveCursorAccount,
  syncCursorUsageCaches,
  upsertCursorAccount,
} from "@toktracker/token-calc";
import { z } from "zod";

const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
const dataDir = process.env.TOKTRACKER_DATA_DIR ?? join(home, ".toktracker");
await mkdir(dataDir, { recursive: true });
const PRICING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Version 8 drops Cloud Agent / Automation ids from project names; Cursor's
// usage CSV has no workspace, so those ids stay on the session title instead.
const INDEX_SCHEMA_VERSION = 8;
const MAX_GATEWAY_BODY_BYTES = 16 * 1024 * 1024;
// AES-GCM payloads are base64 encoded, so leave room for that expansion.
const MAX_BATCH_PLAINTEXT_BYTES = 11 * 1024 * 1024;
const MAX_BATCH_UNENCRYPTED_BYTES = 15 * 1024 * 1024;
const MAX_BATCH_SESSIONS = 10_000;
const MAX_BATCH_MESSAGES = 100_000;
const MAX_BATCH_SOURCE_UPDATES = 10_000;
const UPDATE_POLICY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_ATTEMPT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cursorSyncIntervalMs = clampCursorSyncIntervalMs(
  Number(
    process.env.TOKTRACKER_CURSOR_SYNC_INTERVAL_MS ??
      DEFAULT_CURSOR_SYNC_INTERVAL_MS
  )
);
let cursorLastError: string | undefined;
let cursorLastSyncAt: number | undefined;

const optionalStringSchema = z.string();
const historyRowSchema = z.record(z.string(), z.json());
const cleanSessionTitle = <Value>(value: Value): string | undefined => {
  const parsed = optionalStringSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const title = parsed.data.replaceAll(/\s+/gu, " ").trim();
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
        const row = historyRowSchema.parse(JSON.parse(line));
        const id = optionalStringSchema.safeParse(row[idField]);
        const title = cleanSessionTitle(row[titleField]);
        if (id.success && title && !titles.has(id.data)) {
          titles.set(id.data, title);
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
      // SAFETY: bun:sqlite returns rows matching the explicitly selected thread columns.
      const rows = state
        .query("SELECT id,name,title,first_user_message FROM threads")
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .all() as {
        first_user_message: string | null;
        id: string;
        name: string | null;
        title: string | null;
      }[];
      state.close();
      for (const row of rows) {
        const { id } = row;
        const title =
          cleanSessionTitle(row.name) ??
          cleanSessionTitle(row.title) ??
          cleanSessionTitle(row.first_user_message);
        if (title) {
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
  parseCatalog: (value: JsonValue) => PriceCatalog
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
    const rawCatalog = z.json().parse(await response.json());
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

const [pricingCatalog, initialSessionTitles] = await Promise.all([
  process.env.TOKTRACKER_DISABLE_PRICING === "1" ? {} : loadPricingCatalog(),
  loadSessionTitles(),
]);
let sessionTitles = initialSessionTitles;
const sessionTitleFingerprint = (titles: Map<string, string>): string =>
  Bun.hash(JSON.stringify([...titles].toSorted())).toString(16);
const db = new Database(join(dataDir, "client.db"), { create: true });
db.exec(
  "CREATE TABLE IF NOT EXISTS indexed_files(path TEXT PRIMARY KEY,mtime_ms REAL NOT NULL,size INTEGER NOT NULL,uploaded_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS indexed_sessions(source_path TEXT NOT NULL,session_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(source_path,session_id));CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)"
);
const indexVersion = Bun.hash(
  JSON.stringify([
    INDEX_SCHEMA_VERSION,
    pricingCatalog,
    sessionTitleFingerprint(sessionTitles),
  ])
).toString(16);
const previousIndexVersion =
  // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
  (
    db.query("SELECT value FROM settings WHERE key='index_version'").get() as {
      value: string;
    } | null
  )?.value;
if (previousIndexVersion !== indexVersion) {
  db.exec(
    "DELETE FROM indexed_sessions; UPDATE indexed_files SET mtime_ms=-1,size=-1"
  );
  db.query(
    "INSERT INTO settings(key,value) VALUES('index_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(indexVersion);
}
let deviceId =
  // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
  (
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
  const cursorPaths = resolveCursorPaths(dataDir, home);
  const existingAccounts = await listCursorAccounts(cursorPaths);
  try {
    const cursorSync = await syncCursorUsageCaches(cursorPaths, {
      freshnessMs: cursorSyncIntervalMs,
    });
    const accounts = await listCursorAccounts(cursorPaths);
    const added = accounts.filter(
      (account) =>
        !existingAccounts.some((existing) => existing.id === account.id)
    );
    if (added.length > 0) {
      console.log(
        `TokTracker: using Cursor desktop auth (${added
          .map((account) => account.label ?? account.id)
          .join(", ")})`
      );
    }
    if (cursorSync.synced) {
      cursorLastSyncAt = Date.now();
      cursorLastError = cursorSync.error;
    } else if (cursorSync.error && !cursorSync.synced) {
      cursorLastError = cursorSync.error;
      console.warn(
        `TokTracker: Cursor usage sync skipped (${cursorSync.error})`
      );
    }
  } catch (error) {
    cursorLastError = error instanceof Error ? error.message : String(error);
    console.warn("TokTracker: Cursor usage sync failed", error);
  }
  for (const path of await listCursorUsageCsvFiles(cursorPaths)) {
    add({ kind: "cursor", path });
  }
  const openclawRoots = [
    process.env.OPENCLAW_HOME,
    join(home, ".openclaw"),
    join(home, ".clawdbot"),
    join(home, ".moltbot"),
    join(home, ".moldbot"),
  ].filter((root): root is string => Boolean(root));
  for (const root of openclawRoots) {
    await scan(join(root, "agents"), "**/*.jsonl*", "openclaw");
  }
  return sources;
}
async function fingerprint(path: string, companion?: string) {
  const stat = await Bun.file(path).stat();
  let mtime = stat.mtimeMs,
    { size } = stat;
  const relatedPaths = [`${path}-wal`, `${path}-shm`];
  if (companion) {
    relatedPaths.push(companion);
  }
  for (const related of relatedPaths) {
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
    case "cursor": {
      return parseCursorCsv(text, source.path);
    }
    case "openclaw": {
      return parseOpenClaw(text, source.path, mtime);
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
  companion?: string;
  sourcePath: string;
  mtime: number;
  size: number;
  hashes: Map<string, string>;
}
interface SyncPlan {
  removedSources: string[];
  sessions: SessionSnapshot[];
  sourceUpdates: NonNullable<IngestRequest["sourceUpdates"]>;
  scans: ScanState[];
}
const sqliteKinds = new Set(["opencode-sqlite", "hermes", "copilot-desktop"]);
const sessionHash = (messages: UsageMessage[]) =>
  Bun.hash(JSON.stringify(messages)).toString(16);

async function changedSessions(): Promise<SyncPlan> {
  const plan: SyncPlan = {
    removedSources: [],
    scans: [],
    sessions: [],
    sourceUpdates: [],
  };
  const latestSessionTitles = await loadSessionTitles();
  const titlesChanged =
    sessionTitleFingerprint(sessionTitles) !==
    sessionTitleFingerprint(latestSessionTitles);
  sessionTitles = latestSessionTitles;
  const sources = await discover();
  const discoveredPaths = new Set(sources.map((source) => source.path));
  // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
  const indexedPaths = db.query("SELECT path FROM indexed_files").all() as {
    path: string;
  }[];
  plan.removedSources = indexedPaths
    .map((row) => row.path)
    .filter((path) => !discoveredPaths.has(path));
  for (const sourcePath of plan.removedSources) {
    plan.sourceUpdates.push({ mode: "replace", sourcePath });
  }
  for (const source of sources) {
    try {
      const fp = await fingerprint(source.path, source.companion);
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      const known = db
        .query("SELECT mtime_ms,size FROM indexed_files WHERE path=?")
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .get(source.path) as { mtime_ms: number; size: number } | null;
      if (
        !titlesChanged &&
        known &&
        known.mtime_ms === fp.mtime &&
        known.size === fp.size
      ) {
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
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      const previousRows = db
        .query(
          "SELECT session_id,content_hash FROM indexed_sessions WHERE source_path=?"
        )
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .all(source.path) as { session_id: string; content_hash: string }[];
      const previous = new Map(
        previousRows.map((row) => [row.session_id, row.content_hash])
      );
      const incremental = sqliteKinds.has(source.kind);
      const removed = incremental
        ? [...previous.keys()].filter((id) => !hashes.has(id))
        : [];
      const sourceUpdate: NonNullable<IngestRequest["sourceUpdates"]>[number] =
        {
          mode: incremental ? "patch" : "replace",
          sourcePath: source.path,
        };
      if (incremental && removed.length > 0) {
        sourceUpdate.removedSessionIds = removed;
      }
      plan.sourceUpdates.push(sourceUpdate);
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
        companion: source.companion,
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
    for (const sourcePath of plan.removedSources) {
      db.query("DELETE FROM indexed_sessions WHERE source_path=?").run(
        sourcePath
      );
      db.query("DELETE FROM indexed_files WHERE path=?").run(sourcePath);
    }
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

const byteLength = <Value>(value: Value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

let warnedAboutInsecureGateway = false;
const warnAboutInsecureGateway = (
  endpoint: string,
  accessKey?: string
): void => {
  if (!accessKey || warnedAboutInsecureGateway) {
    return;
  }
  try {
    const url = new URL(endpoint);
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      url.hostname.startsWith("127.");
    if (url.protocol === "https:" || isLoopback) {
      return;
    }
    warnedAboutInsecureGateway = true;
    console.warn(
      "TokTracker: WARNING: the configured ingestion key may be exposed over non-loopback HTTP. Configure HTTPS for the gateway."
    );
  } catch {
    // fetch() reports malformed gateway URLs with its normal error.
  }
};

const validatePayload = (payload: IngestRequest): void => {
  const completeCandidate = { ...payload };
  if (isIngestRequest(completeCandidate)) {
    return;
  }
  for (const session of payload.sessions) {
    const candidate = { device: payload.device, sessions: [session] };
    if (!isIngestRequest(candidate)) {
      for (const [messageIndex, message] of session.messages.entries()) {
        const messageCandidate = {
          device: payload.device,
          sessions: [{ ...session, messages: [message] }],
        };
        if (!isIngestRequest(messageCandidate)) {
          throw new Error(
            `Invalid ingestion message ${messageIndex} in session ${session.sessionId} from ${session.sourcePath}`
          );
        }
      }
      throw new Error(
        `Invalid ingestion session ${session.sessionId} from ${session.sourcePath}`
      );
    }
  }
  const deviceCandidate = { device: payload.device, sessions: [] };
  if (!isIngestRequest(deviceCandidate)) {
    throw new Error("Invalid ingestion device metadata");
  }
  for (const sourceUpdate of payload.sourceUpdates ?? []) {
    const updateCandidate = {
      device: payload.device,
      sessions: [],
      sourceUpdates: [sourceUpdate],
    };
    if (!isIngestRequest(updateCandidate)) {
      throw new Error(
        `Invalid ingestion source update for ${sourceUpdate.sourcePath} (${sourceUpdate.removedSessionIds?.length ?? 0} removals)`
      );
    }
  }
  throw new Error("Invalid ingestion payload limits");
};

async function upload(payload: IngestRequest, accessKey?: string) {
  validatePayload(payload);
  const endpoint = process.env.TOKTRACKER_GATEWAY ?? "http://localhost:3000";
  const requestPayload = accessKey
    ? await encryptPayload(payload, accessKey)
    : payload;
  const requestBody = JSON.stringify(requestPayload);
  if (
    new TextEncoder().encode(requestBody).byteLength > MAX_GATEWAY_BODY_BYTES
  ) {
    throw new Error("A single ingestion batch exceeds the gateway body limit");
  }
  const send = (authorization?: string): Promise<Response> => {
    const headers = new Headers({ "content-type": "application/json" });
    if (authorization) {
      headers.set("authorization", authorization);
    }
    return fetch(`${endpoint}/api/v1/ingest`, {
      body: requestBody,
      headers,
      method: "POST",
    });
  };
  // Current gateways authenticate ingestion by successfully decrypting it, so
  // the shared key does not need to travel in an HTTP header. Retry with the
  // legacy header only when talking to an older gateway.
  let response = await send();
  if (response.status === 401 && accessKey) {
    warnAboutInsecureGateway(endpoint, accessKey);
    response = await send(`Bearer ${accessKey}`);
  }
  if (!response.ok) {
    throw new Error(
      `Gateway rejected upload: ${response.status} ${await response.text()}`
    );
  }
}

async function uploadPlan(plan: SyncPlan) {
  const accessKey = process.env.TOKTRACKER_API_KEY;
  const maxBatchBytes = accessKey
    ? MAX_BATCH_PLAINTEXT_BYTES
    : MAX_BATCH_UNENCRYPTED_BYTES;
  const device = {
    id: deviceId!,
    name: process.env.TOKTRACKER_DEVICE_NAME ?? hostname(),
    platform: platform(),
  };
  const sessionsBySource = new Map<string, SessionSnapshot[]>();
  for (const session of plan.sessions) {
    const sessions = sessionsBySource.get(session.sourcePath) ?? [];
    sessions.push(session);
    sessionsBySource.set(session.sourcePath, sessions);
  }
  let batch: IngestRequest = { device, sessions: [], sourceUpdates: [] };
  let batchMessageCount = 0;
  const flush = async () => {
    if (batch.sessions.length === 0 && batch.sourceUpdates?.length === 0) {
      return;
    }
    await upload(
      {
        ...batch,
        requestId: crypto.randomUUID(),
        sentAt: Date.now(),
      },
      accessKey
    );
    batch = { device, sessions: [], sourceUpdates: [] };
    batchMessageCount = 0;
  };
  const appendToBatch = (
    current: IngestRequest,
    session?: SessionSnapshot,
    sourceUpdate?: NonNullable<IngestRequest["sourceUpdates"]>[number]
  ): IngestRequest => ({
    device,
    sessions: session ? [...current.sessions, session] : current.sessions,
    sourceUpdates: sourceUpdate
      ? [...(current.sourceUpdates ?? []), sourceUpdate]
      : current.sourceUpdates,
  });
  const fitsBatch = (candidate: IngestRequest, messageCount: number) =>
    candidate.sessions.length <= MAX_BATCH_SESSIONS &&
    messageCount <= MAX_BATCH_MESSAGES &&
    (candidate.sourceUpdates?.length ?? 0) <= MAX_BATCH_SOURCE_UPDATES &&
    byteLength(candidate) <= maxBatchBytes;
  const add = async (
    session?: SessionSnapshot,
    sourceUpdate?: NonNullable<IngestRequest["sourceUpdates"]>[number]
  ) => {
    const messageCount = session?.messages.length ?? 0;
    const candidate = appendToBatch(batch, session, sourceUpdate);
    if (!fitsBatch(candidate, batchMessageCount + messageCount)) {
      await flush();
      const single = appendToBatch(batch, session, sourceUpdate);
      if (!fitsBatch(single, messageCount)) {
        throw new Error(
          `Session ${session?.sessionId ?? sourceUpdate?.sourcePath} exceeds the ingestion batch limit`
        );
      }
    }
    batch = appendToBatch(batch, session, sourceUpdate);
    batchMessageCount += messageCount;
  };
  for (const sourceUpdate of plan.sourceUpdates) {
    const sessions = sessionsBySource.get(sourceUpdate.sourcePath) ?? [];
    if (sessions.length === 0) {
      await add(undefined, sourceUpdate);
      continue;
    }
    for (const [index, session] of sessions.entries()) {
      await add(session, index === 0 ? sourceUpdate : undefined);
    }
  }
  await flush();
}

interface ClientUpdatePolicy {
  channel: "nightly" | "stable";
  enabled: boolean;
  windowEndHour: number;
  windowStartHour: number;
}

const isInUpdateWindow = (policy: ClientUpdatePolicy): boolean => {
  const hour = new Date().getHours();
  return policy.windowStartHour < policy.windowEndHour
    ? hour >= policy.windowStartHour && hour < policy.windowEndHour
    : hour >= policy.windowStartHour || hour < policy.windowEndHour;
};

const settingTimestamp = (key: string): number =>
  Number(
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    (
      db.query("SELECT value FROM settings WHERE key=?").get(key) as {
        value: string;
      } | null
    )?.value ?? 0
  );
const setSettingTimestamp = (key: string): void => {
  db.query(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, String(Date.now()));
};

const applyGatewayUpdatePolicy = async (): Promise<void> => {
  if (process.env.TOKTRACKER_GATEWAY_AUTO_UPDATE === "0") {
    return;
  }
  if (
    Date.now() - settingTimestamp("gateway_update_policy_checked_at") <
    UPDATE_POLICY_CHECK_INTERVAL_MS
  ) {
    return;
  }
  const endpoint = process.env.TOKTRACKER_GATEWAY ?? "http://localhost:3000";
  const accessKey = process.env.TOKTRACKER_API_KEY;
  warnAboutInsecureGateway(endpoint, accessKey);
  try {
    const response = await fetch(`${endpoint}/api/v1/client-update-policy`, {
      headers: accessKey ? { authorization: `Bearer ${accessKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return;
    }
    setSettingTimestamp("gateway_update_policy_checked_at");
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const policy = (await response.json()) as ClientUpdatePolicy;
    if (
      !policy.enabled ||
      !isInUpdateWindow(policy) ||
      Date.now() - settingTimestamp("gateway_update_attempted_at") <
        UPDATE_ATTEMPT_INTERVAL_MS
    ) {
      return;
    }
    setSettingTimestamp("gateway_update_attempted_at");
    await autoUpdateClient(policy.channel);
  } catch (error) {
    console.warn("TokTracker: gateway-controlled update check failed", error);
  }
};

const cursorDashboardEnabled = (): boolean =>
  process.env.TOKTRACKER_CURSOR_DASHBOARD !== "0";

const cursorClientPolicySchema = z.object({
  commands: z.array(
    z.object({
      accountId: z.string().optional(),
      id: z.string(),
      label: z.string().optional(),
      token: z.string().optional(),
      type: z.string(),
    })
  ),
  syncIntervalMs: z.number().finite().positive(),
});

const gatewayHeaders = (): Headers => {
  const headers = new Headers();
  const accessKey = process.env.TOKTRACKER_API_KEY;
  if (accessKey) {
    headers.set("authorization", `Bearer ${accessKey}`);
  }
  return headers;
};

const applyCursorCommands = async (): Promise<void> => {
  if (!cursorDashboardEnabled()) {
    return;
  }
  const endpoint = process.env.TOKTRACKER_GATEWAY ?? "http://localhost:3000";
  const accessKey = process.env.TOKTRACKER_API_KEY;
  warnAboutInsecureGateway(endpoint, accessKey);
  const cursorPaths = resolveCursorPaths(dataDir, home);
  try {
    const policyResponse = await fetch(
      `${endpoint}/api/v1/client-cursor-policy?deviceId=${encodeURIComponent(deviceId!)}`,
      {
        headers: gatewayHeaders(),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!policyResponse.ok) {
      return;
    }
    const policy = cursorClientPolicySchema.parse(await policyResponse.json());
    cursorSyncIntervalMs = clampCursorSyncIntervalMs(policy.syncIntervalMs);
    const acknowledged: string[] = [];
    for (const command of policy.commands) {
      try {
        if (command.type === "import-desktop") {
          await importDesktopCursorAccounts(cursorPaths);
        } else if (command.type === "add-account" && command.token) {
          await upsertCursorAccount(cursorPaths, command.token, command.label);
        } else if (command.type === "remove-account" && command.accountId) {
          await removeCursorAccount(cursorPaths, command.accountId, true);
        } else if (command.type === "switch-account" && command.accountId) {
          await setActiveCursorAccount(cursorPaths, command.accountId);
        }
        acknowledged.push(command.id);
      } catch (error) {
        cursorLastError =
          error instanceof Error ? error.message : String(error);
      }
    }
    if (acknowledged.length > 0) {
      await fetch(`${endpoint}/api/v1/client-cursor-commands/ack`, {
        body: JSON.stringify({
          commandIds: acknowledged,
          deviceId,
        }),
        headers: (() => {
          const headers = gatewayHeaders();
          headers.set("content-type", "application/json");
          return headers;
        })(),
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch (error) {
    console.warn("TokTracker: Cursor dashboard commands failed", error);
  }
};

const reportCursorStatus = async (): Promise<void> => {
  if (!cursorDashboardEnabled()) {
    return;
  }
  const endpoint = process.env.TOKTRACKER_GATEWAY ?? "http://localhost:3000";
  const cursorPaths = resolveCursorPaths(dataDir, home);
  try {
    const desktop = readDesktopCursorSessions(home);
    const accounts = await listCursorAccounts(cursorPaths);
    await fetch(`${endpoint}/api/v1/client-cursor-status`, {
      body: JSON.stringify({
        accounts: accounts.map((account) => ({
          id: account.id,
          isActive: account.isActive,
          label: account.label,
        })),
        desktopEmail: desktop[0]?.email,
        desktopSignedIn: desktop.length > 0,
        deviceId,
        lastError: cursorLastError,
        lastSyncAt: cursorLastSyncAt,
        syncIntervalMs: cursorSyncIntervalMs,
      }),
      headers: (() => {
        const headers = gatewayHeaders();
        headers.set("content-type", "application/json");
        return headers;
      })(),
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.warn("TokTracker: Cursor dashboard status failed", error);
  }
};

const planIsCurrent = async (plan: SyncPlan): Promise<boolean> => {
  for (const scan of plan.scans) {
    try {
      const current = await fingerprint(scan.sourcePath, scan.companion);
      if (current.mtime !== scan.mtime || current.size !== scan.size) {
        return false;
      }
    } catch {
      return false;
    }
  }
  for (const sourcePath of plan.removedSources) {
    if (await Bun.file(sourcePath).exists()) {
      return false;
    }
  }
  return true;
};

async function sync() {
  await applyGatewayUpdatePolicy();
  await applyCursorCommands();
  const plan = await changedSessions();
  await reportCursorStatus();
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
  if (!(await planIsCurrent(plan))) {
    console.warn("TokTracker: sources changed during sync; rescanning");
    return sync();
  }
  await uploadPlan(plan);
  commit(plan);
  console.log(
    `TokTracker: uploaded ${plan.sessions.length} changed session(s)`
  );
}
let syncInFlight: Promise<void> | undefined;
const serializedSync = (): Promise<void> => {
  if (!syncInFlight) {
    syncInFlight = sync().finally(() => {
      syncInFlight = undefined;
    });
  }
  return syncInFlight;
};
await serializedSync();
const interval = Number(process.env.TOKTRACKER_INTERVAL_MS ?? 60_000);
if (process.env.TOKTRACKER_ONCE !== "1") {
  setInterval(() => serializedSync().catch(console.error), interval);
}
