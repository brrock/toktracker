import { Database } from "bun:sqlite";

import type {
  DashboardSummary,
  IngestRequest,
  SessionSort,
  SessionSummary,
  SessionUsagePart,
  TimeRange,
  TokenBreakdown,
  UsageDetail,
  UsageMessage,
} from "@toktracker/shared";
import {
  canonicalModelId,
  clampCursorSyncIntervalMs,
  DEFAULT_CURSOR_SYNC_INTERVAL_MS,
  isHermesMessage,
  projectLabel,
  summarize,
  totalTokens,
} from "@toktracker/token-calc";
import { z } from "zod";

const pad = (value: number): string => value.toString().padStart(2, "0");
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const INGESTION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const SYNARA_HOST_CONTEXT =
  /<synara_host_context>[\s\S]*?<\/synara_host_context>/giu;

const hashSecret = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
const randomToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const normalizePairingCode = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9]/gu, "").toUpperCase();
const generatePairingCode = (): string =>
  normalizePairingCode(crypto.randomUUID())
    .slice(0, 16)
    .match(/.{1,4}/gu)
    ?.join("-") ?? crypto.randomUUID();

export interface DashboardDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

export interface DashboardCredentials {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export interface ClientAutoUpdateSettings {
  channel: "nightly" | "stable";
  enabled: boolean;
  windowEndHour: number;
  windowStartHour: number;
}

export interface CursorAccountStatus {
  id: string;
  isActive: boolean;
  label?: string;
}

export interface CursorDeviceStatus {
  accounts: CursorAccountStatus[];
  desktopEmail?: string;
  desktopSignedIn: boolean;
  deviceId: string;
  lastError?: string;
  lastSyncAt?: number;
  syncIntervalMs: number;
}

export type CursorDeviceCommand =
  | { accountId: string; id: string; type: "remove-account" }
  | { accountId: string; id: string; type: "switch-account" }
  | { id: string; label?: string; token: string; type: "add-account" }
  | { id: string; type: "import-desktop" };

export type CursorCommandDraft =
  | { accountId: string; type: "remove-account" }
  | { accountId: string; type: "switch-account" }
  | { label?: string; token: string; type: "add-account" }
  | { type: "import-desktop" };

export interface CursorDashboardSettings {
  enabled: boolean;
  syncIntervalMs: number;
}

export interface CursorDashboardOverview {
  devices: (CursorDeviceStatus & {
    name?: string;
    updatedAt: number;
  })[];
  enabled: boolean;
  syncIntervalMs: number;
}

const clientAutoUpdateSettingsSchema: z.ZodType<ClientAutoUpdateSettings> =
  z.object({
    channel: z.enum(["stable", "nightly"]),
    enabled: z.boolean(),
    windowEndHour: z.number().int().min(0).max(23),
    windowStartHour: z.number().int().min(0).max(23),
  });

const DEFAULT_CLIENT_AUTO_UPDATE_SETTINGS: ClientAutoUpdateSettings = {
  channel: "stable",
  enabled: false,
  windowEndHour: 4,
  windowStartHour: 2,
};

const cursorAccountStatusSchema = z.object({
  id: z.string().trim().min(1).max(128),
  isActive: z.boolean(),
  label: z.string().trim().max(128).optional(),
});
const cursorDeviceStatusSchema: z.ZodType<
  Omit<CursorDeviceStatus, "deviceId">
> = z.object({
  accounts: z.array(cursorAccountStatusSchema).max(50),
  desktopEmail: z.string().trim().max(320).optional(),
  desktopSignedIn: z.boolean(),
  lastError: z.string().trim().max(1024).optional(),
  lastSyncAt: z.number().int().safe().nonnegative().optional(),
  syncIntervalMs: z.number().finite().positive(),
});
const storedCursorDeviceStatusSchema: z.ZodType<CursorDeviceStatus> = z.object({
  accounts: z.array(cursorAccountStatusSchema).max(50),
  desktopEmail: z.string().trim().max(320).optional(),
  desktopSignedIn: z.boolean(),
  deviceId: z.string().trim().min(1).max(128),
  lastError: z.string().trim().max(1024).optional(),
  lastSyncAt: z.number().int().safe().nonnegative().optional(),
  syncIntervalMs: z.number().finite().positive(),
});
const cursorDashboardSettingsSchema: z.ZodType<CursorDashboardSettings> =
  z.object({
    enabled: z.boolean(),
    syncIntervalMs: z.number().finite().positive(),
  });
const cursorDeviceCommandSchema: z.ZodType<CursorDeviceCommand> =
  z.discriminatedUnion("type", [
    z.object({
      id: z.string().min(1),
      type: z.literal("import-desktop"),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().max(128).optional(),
      token: z.string().min(1).max(8192),
      type: z.literal("add-account"),
    }),
    z.object({
      accountId: z.string().min(1).max(128),
      id: z.string().min(1),
      type: z.literal("remove-account"),
    }),
    z.object({
      accountId: z.string().min(1).max(128),
      id: z.string().min(1),
      type: z.literal("switch-account"),
    }),
  ]);
const DEFAULT_CURSOR_DASHBOARD_SETTINGS: CursorDashboardSettings = {
  enabled: true,
  syncIntervalMs: DEFAULT_CURSOR_SYNC_INTERVAL_MS,
};

interface StoredSessionRow {
  device_id: string;
  source_path: string;
  session_id: string;
  project: string | null;
}

interface StoredUsageRow {
  device_id: string;
  source_path: string;
  session_id: string;
  client: string;
  model_id: string;
  provider_id: string;
  workspace_key: string | null;
  workspace_label: string | null;
  timestamp: number;
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost: number;
  cost_source: UsageMessage["costSource"];
  duration_ms: number | null;
  message_count: number;
  agent: string | null;
  dedup_key: string | null;
  session_title: string | null;
  is_turn_start: number;
}

interface SessionIdentity {
  deviceId: string;
  sourcePath: string;
  sessionId: string;
}

const sessionIdentity = (row: StoredSessionRow): SessionIdentity => ({
  deviceId: row.device_id,
  sessionId: row.session_id,
  sourcePath: row.source_path,
});

const sessionApiId = (identity: SessionIdentity): string =>
  Buffer.from(JSON.stringify(identity)).toString("base64url");

const sessionIdentitySchema: z.ZodType<SessionIdentity> = z.object({
  deviceId: z.string(),
  sessionId: z.string(),
  sourcePath: z.string(),
});

const parseSessionApiId = (id: string): SessionIdentity | undefined => {
  try {
    const value = sessionIdentitySchema.safeParse(
      JSON.parse(Buffer.from(id, "base64url").toString())
    );
    return value.success ? value.data : undefined;
  } catch {
    return undefined;
  }
};

const appendGroup = (
  map: Map<string, UsageMessage[]>,
  key: string,
  message: UsageMessage
): void => {
  const group = map.get(key);
  if (group) {
    group.push(message);
  } else {
    map.set(key, [message]);
  }
};

const cleanSessionTitle = (title: string | undefined): string | undefined => {
  const cleaned = title?.replaceAll(SYNARA_HOST_CONTEXT, "").trim();
  return cleaned || undefined;
};

const withProject = (
  message: UsageMessage,
  storedProject: string | null
): UsageMessage => ({
  ...message,
  sessionTitle: cleanSessionTitle(message.sessionTitle),
  workspaceLabel: isHermesMessage(message)
    ? undefined
    : (message.workspaceLabel ?? storedProject ?? undefined),
});

const fuzzyMatch = (candidate: string, query: string): boolean => {
  let queryIndex = 0;
  for (const character of candidate) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
};

const matchesSessionQuery = (
  session: SessionSummary,
  query: string
): boolean => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const searchable = [
    session.id,
    session.sessionId,
    session.sourcePath,
    session.deviceId,
    session.title ?? "",
    session.client,
    session.model,
    session.project,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every(
    (term) => searchable.includes(term) || fuzzyMatch(searchable, term)
  );
};

const sessionProject = (messages: UsageMessage[]): string => {
  for (const message of messages) {
    const project = projectLabel(message);
    if (project) {
      return project;
    }
  }
  return "No project";
};

const messageFromRow = (row: StoredUsageRow): UsageMessage => ({
  agent: row.agent ?? undefined,
  client: row.client,
  cost: row.cost,
  costSource: row.cost_source,
  date: row.date,
  dedupKey: row.dedup_key ?? undefined,
  durationMs: row.duration_ms ?? undefined,
  isTurnStart: Boolean(row.is_turn_start),
  messageCount: row.message_count,
  modelId: row.model_id,
  providerId: row.provider_id,
  sessionId: row.session_id,
  sessionTitle: cleanSessionTitle(row.session_title ?? undefined),
  timestamp: row.timestamp,
  tokens: {
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens,
    input: row.input_tokens,
    output: row.output_tokens,
    reasoning: row.reasoning_tokens,
  },
  workspaceKey: row.workspace_key ?? undefined,
  workspaceLabel: row.workspace_label ?? undefined,
});

const addTokens = (total: TokenBreakdown, next: TokenBreakdown): void => {
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.input += next.input;
  total.output += next.output;
  total.reasoning += next.reasoning;
};

const sessionParts = (messages: UsageMessage[]): SessionUsagePart[] => {
  const parts: SessionUsagePart[] = [];
  for (const message of messages) {
    const model = canonicalModelId(message.modelId);
    const previous = parts.at(-1);
    if (
      previous &&
      previous.model === model &&
      previous.provider === message.providerId
    ) {
      addTokens(previous.tokens, message.tokens);
      previous.cost += message.cost;
      previous.messages += message.messageCount;
      previous.lastSeen = Math.max(
        previous.lastSeen,
        message.timestamp + (message.durationMs ?? 0)
      );
      continue;
    }
    parts.push({
      cost: message.cost,
      lastSeen: message.timestamp + (message.durationMs ?? 0),
      messages: message.messageCount,
      model,
      provider: message.providerId,
      startedAt: message.timestamp,
      tokens: { ...message.tokens },
    });
  }
  return parts;
};

const summarizeGroups = (
  groups: Map<string, UsageMessage[]>
): Record<string, UsageDetail> =>
  Object.fromEntries(
    [...groups].map(([name, groupMessages]) => {
      const summary = summarize(groupMessages);
      return [
        name,
        {
          agents: summary.agents,
          daily: summary.daily,
          models: summary.models,
          projects: summary.projects,
        },
      ];
    })
  );

export class Store {
  private db: Database;
  constructor(path = process.env.TOKTRACKER_DB ?? "toktracker.db") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, last_seen INTEGER NOT NULL, banned_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (device_id TEXT NOT NULL, source_path TEXT NOT NULL, source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL, session_id TEXT NOT NULL, project TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(device_id, source_path, session_id), FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_usage (device_id TEXT NOT NULL, source_path TEXT NOT NULL, session_id TEXT NOT NULL, message_index INTEGER NOT NULL, client TEXT NOT NULL, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, workspace_key TEXT, workspace_label TEXT, timestamp REAL NOT NULL, date TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cost REAL NOT NULL, cost_source TEXT NOT NULL, duration_ms REAL, message_count INTEGER NOT NULL, agent TEXT, dedup_key TEXT, session_title TEXT, is_turn_start INTEGER NOT NULL, PRIMARY KEY(device_id, source_path, session_id, message_index), FOREIGN KEY(device_id, source_path, session_id) REFERENCES sessions(device_id, source_path, session_id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS session_usage_timestamp ON session_usage(timestamp);
      CREATE TABLE IF NOT EXISTS dashboard_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_pairing_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_tokens (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(device_id) REFERENCES dashboard_devices(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS dashboard_tokens_device ON dashboard_tokens(device_id);
      CREATE TABLE IF NOT EXISTS gateway_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ingestion_requests (device_id TEXT NOT NULL, request_id TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(device_id,request_id));
      CREATE INDEX IF NOT EXISTS ingestion_requests_received_at ON ingestion_requests(received_at);
      CREATE TABLE IF NOT EXISTS cursor_device_status (device_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursor_device_commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, created_at INTEGER NOT NULL, command TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cursor_device_commands_device ON cursor_device_commands(device_id);
    `);
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const deviceColumns = this.db.query("PRAGMA table_info(devices)").all() as {
      name: string;
    }[];
    if (!deviceColumns.some((column) => column.name === "banned_at")) {
      this.db.exec("ALTER TABLE devices ADD COLUMN banned_at INTEGER");
    }
    const authCleanupTime = Date.now();
    this.db
      .query("DELETE FROM dashboard_pairing_codes WHERE expires_at<=?")
      .run(authCleanupTime);
    this.db
      .query("DELETE FROM dashboard_tokens WHERE expires_at<=?")
      .run(authCleanupTime);
    this.db.exec(
      "DELETE FROM dashboard_devices WHERE NOT EXISTS (SELECT 1 FROM dashboard_tokens WHERE dashboard_tokens.device_id=dashboard_devices.id AND kind='refresh')"
    );
    this.migrateSessions();
  }

  private migrateSessions(): void {
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const columns = this.db.query("PRAGMA table_info(sessions)").all() as {
      name: string;
      pk: number;
    }[];
    const primaryKey = columns
      .filter((column) => column.pk > 0)
      .toSorted((a, b) => a.pk - b.pk)
      .map((column) => column.name)
      .join(",");
    if (
      !columns.some((column) => column.name === "messages_json") &&
      primaryKey === "device_id,source_path,session_id"
    ) {
      return;
    }

    const migrate = this.db.transaction(() => {
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      const legacyRows = this.db
        .query("SELECT * FROM sessions")
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .all() as (StoredSessionRow & {
        messages_json: string;
        source_mtime_ms: number;
        source_size: number;
        updated_at: number;
      })[];
      this.db.exec(
        "DROP TABLE IF EXISTS session_usage; ALTER TABLE sessions RENAME TO sessions_legacy;"
      );
      this.db.exec(`
        CREATE TABLE sessions (device_id TEXT NOT NULL, source_path TEXT NOT NULL, source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL, session_id TEXT NOT NULL, project TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(device_id, source_path, session_id), FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE);
        CREATE TABLE session_usage (device_id TEXT NOT NULL, source_path TEXT NOT NULL, session_id TEXT NOT NULL, message_index INTEGER NOT NULL, client TEXT NOT NULL, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, workspace_key TEXT, workspace_label TEXT, timestamp REAL NOT NULL, date TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cost REAL NOT NULL, cost_source TEXT NOT NULL, duration_ms REAL, message_count INTEGER NOT NULL, agent TEXT, dedup_key TEXT, session_title TEXT, is_turn_start INTEGER NOT NULL, PRIMARY KEY(device_id, source_path, session_id, message_index), FOREIGN KEY(device_id, source_path, session_id) REFERENCES sessions(device_id, source_path, session_id) ON DELETE CASCADE);
        CREATE INDEX session_usage_timestamp ON session_usage(timestamp);
      `);
      const putSession = this.db.query(
        "INSERT INTO sessions(device_id,source_path,source_mtime_ms,source_size,session_id,project,updated_at) VALUES(?,?,?,?,?,?,?)"
      );
      const putUsage = this.usageInsertStatement();
      for (const row of legacyRows) {
        putSession.run(
          row.device_id,
          row.source_path,
          row.source_mtime_ms,
          row.source_size,
          row.session_id,
          row.project,
          row.updated_at
        );
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        const messages = JSON.parse(row.messages_json) as UsageMessage[];
        for (const [index, message] of messages.entries()) {
          Store.insertUsage(
            putUsage,
            row.device_id,
            row.source_path,
            row.session_id,
            index,
            message
          );
        }
      }
      this.db.exec("DROP TABLE sessions_legacy;");
    });
    migrate();
  }

  close(): void {
    this.db.close();
  }

  createDashboardPairingCode(ttlMs = PAIRING_CODE_TTL_MS) {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const code = generatePairingCode();
    this.db
      .query("DELETE FROM dashboard_pairing_codes WHERE expires_at<=?")
      .run(now);
    this.db
      .query(
        "INSERT INTO dashboard_pairing_codes(code_hash,created_at,expires_at) VALUES(?,?,?)"
      )
      .run(hashSecret(normalizePairingCode(code)), now, expiresAt);
    return { code, expiresAt };
  }

  pairDashboardDevice(
    code: string,
    name: string
  ): DashboardCredentials | undefined {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      const codeHash = hashSecret(normalizePairingCode(code));
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      const pairingCode = this.db
        .query(
          "SELECT code_hash FROM dashboard_pairing_codes WHERE code_hash=? AND expires_at>?"
        )
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .get(codeHash, now) as { code_hash: string } | null;
      if (!pairingCode) {
        return;
      }
      this.db
        .query("DELETE FROM dashboard_pairing_codes WHERE code_hash=?")
        .run(codeHash);
      const deviceId = crypto.randomUUID();
      this.db
        .query(
          "INSERT INTO dashboard_devices(id,name,created_at,last_seen) VALUES(?,?,?,?)"
        )
        .run(deviceId, name, now, now);
      return this.issueDashboardCredentials(deviceId, now);
    });
    return transaction();
  }

  authenticateDashboard(accessToken: string): boolean {
    const now = Date.now();
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const token = this.db
      .query(
        "SELECT device_id FROM dashboard_tokens WHERE token_hash=? AND kind='access' AND expires_at>?"
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .get(hashSecret(accessToken), now) as { device_id: string } | null;
    if (!token) {
      return false;
    }
    this.db
      .query("UPDATE dashboard_devices SET last_seen=? WHERE id=?")
      .run(now, token.device_id);
    return true;
  }

  refreshDashboard(refreshToken: string): DashboardCredentials | undefined {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      const token = this.db
        .query(
          "SELECT device_id FROM dashboard_tokens WHERE token_hash=? AND kind='refresh' AND expires_at>?"
        )
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .get(hashSecret(refreshToken), now) as { device_id: string } | null;
      if (!token) {
        return;
      }
      this.db
        .query("DELETE FROM dashboard_tokens WHERE device_id=?")
        .run(token.device_id);
      this.db
        .query("UPDATE dashboard_devices SET last_seen=? WHERE id=?")
        .run(now, token.device_id);
      return this.issueDashboardCredentials(token.device_id, now);
    });
    return transaction();
  }

  revokeDashboardSession(refreshToken: string): boolean {
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const token = this.db
      .query(
        "SELECT device_id FROM dashboard_tokens WHERE token_hash=? AND kind='refresh'"
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .get(hashSecret(refreshToken)) as { device_id: string } | null;
    return token ? this.revokeDashboardDevice(token.device_id) : false;
  }

  dashboardDevices(): DashboardDevice[] {
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    return (
      this.db
        .query(
          // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
          "SELECT id,name,created_at as createdAt,last_seen as lastSeen FROM dashboard_devices ORDER BY last_seen DESC"
        )
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .all() as DashboardDevice[]
    );
  }

  revokeDashboardDevice(deviceId: string): boolean {
    return (
      this.db.query("DELETE FROM dashboard_devices WHERE id=?").run(deviceId)
        .changes > 0
    );
  }

  banDevice(deviceId: string): boolean {
    return (
      this.db
        .query("UPDATE devices SET banned_at=? WHERE id=?")
        .run(Date.now(), deviceId).changes > 0
    );
  }

  clientAutoUpdateSettings(): ClientAutoUpdateSettings {
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const row = this.db
      .query(
        "SELECT value FROM gateway_settings WHERE key='client_auto_update'"
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .get() as { value: string } | null;
    if (!row) {
      return { ...DEFAULT_CLIENT_AUTO_UPDATE_SETTINGS };
    }
    try {
      const value = clientAutoUpdateSettingsSchema.safeParse(
        JSON.parse(row.value)
      );
      if (
        value.success &&
        value.data.windowStartHour !== value.data.windowEndHour
      ) {
        return value.data;
      }
    } catch {
      // Invalid persisted settings fall back to the safe disabled default.
    }
    return { ...DEFAULT_CLIENT_AUTO_UPDATE_SETTINGS };
  }

  setClientAutoUpdateSettings(
    settings: ClientAutoUpdateSettings
  ): ClientAutoUpdateSettings {
    this.db
      .query(
        "INSERT INTO gateway_settings(key,value) VALUES('client_auto_update',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify(settings));
    return settings;
  }

  cursorDashboardSettings(): CursorDashboardSettings {
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const row = this.db
      .query("SELECT value FROM gateway_settings WHERE key='cursor_dashboard'")
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .get() as { value: string } | null;
    if (!row) {
      return { ...DEFAULT_CURSOR_DASHBOARD_SETTINGS };
    }
    try {
      const parsed = cursorDashboardSettingsSchema.safeParse(
        JSON.parse(row.value)
      );
      if (parsed.success) {
        return {
          enabled: parsed.data.enabled,
          syncIntervalMs: clampCursorSyncIntervalMs(parsed.data.syncIntervalMs),
        };
      }
    } catch {
      // Invalid persisted settings fall back to the enabled default.
    }
    return { ...DEFAULT_CURSOR_DASHBOARD_SETTINGS };
  }

  setCursorDashboardSettings(
    settings: CursorDashboardSettings
  ): CursorDashboardSettings {
    const next = {
      enabled: settings.enabled,
      syncIntervalMs: clampCursorSyncIntervalMs(settings.syncIntervalMs),
    };
    this.db
      .query(
        "INSERT INTO gateway_settings(key,value) VALUES('cursor_dashboard',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify(next));
    return next;
  }

  recordCursorDeviceStatus(status: CursorDeviceStatus): CursorDeviceStatus {
    const body = cursorDeviceStatusSchema.parse({
      accounts: status.accounts,
      desktopEmail: status.desktopEmail,
      desktopSignedIn: status.desktopSignedIn,
      lastError: status.lastError,
      lastSyncAt: status.lastSyncAt,
      syncIntervalMs: clampCursorSyncIntervalMs(status.syncIntervalMs),
    });
    const stored: CursorDeviceStatus = { ...body, deviceId: status.deviceId };
    this.db
      .query(
        "INSERT INTO cursor_device_status(device_id,updated_at,status) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status"
      )
      .run(status.deviceId, Date.now(), JSON.stringify(stored));
    return stored;
  }

  enqueueCursorCommand(
    deviceId: string,
    command: CursorCommandDraft
  ): CursorDeviceCommand {
    const queued = cursorDeviceCommandSchema.parse({
      ...command,
      id: crypto.randomUUID(),
    });
    this.db
      .query(
        "INSERT INTO cursor_device_commands(id,device_id,created_at,command) VALUES(?,?,?,?)"
      )
      .run(queued.id, deviceId, Date.now(), JSON.stringify(queued));
    return queued;
  }

  cursorCommandsForDevice(deviceId: string): CursorDeviceCommand[] {
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const rows = this.db
      .query(
        "SELECT command FROM cursor_device_commands WHERE device_id=? ORDER BY created_at"
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .all(deviceId) as { command: string }[];
    const commands: CursorDeviceCommand[] = [];
    for (const row of rows) {
      try {
        const parsed = cursorDeviceCommandSchema.safeParse(
          JSON.parse(row.command)
        );
        if (parsed.success) {
          commands.push(parsed.data);
        }
      } catch {
        // Skip malformed command payloads.
      }
    }
    return commands;
  }

  ackCursorCommands(deviceId: string, commandIds: string[]): number {
    let removed = 0;
    const statement = this.db.query(
      "DELETE FROM cursor_device_commands WHERE device_id=? AND id=?"
    );
    for (const commandId of commandIds) {
      removed += statement.run(deviceId, commandId).changes;
    }
    return removed;
  }

  cursorDashboardOverview(): CursorDashboardOverview {
    const settings = this.cursorDashboardSettings();
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const names = new Map(
      (
        this.db
          .query("SELECT id,name FROM devices")
          // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
          .all() as { id: string; name: string }[]
      ).map((device) => [device.id, device.name])
    );
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const rows = this.db
      .query(
        "SELECT device_id as deviceId, updated_at as updatedAt, status FROM cursor_device_status ORDER BY updated_at DESC"
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .all() as { deviceId: string; status: string; updatedAt: number }[];
    const devices: CursorDashboardOverview["devices"] = [];
    for (const row of rows) {
      try {
        const parsed = storedCursorDeviceStatusSchema.safeParse(
          JSON.parse(row.status)
        );
        if (!parsed.success) {
          continue;
        }
        devices.push({
          ...parsed.data,
          deviceId: row.deviceId,
          name: names.get(row.deviceId),
          updatedAt: row.updatedAt,
        });
      } catch {
        // Skip malformed status payloads.
      }
    }
    return { ...settings, devices };
  }

  ingest(payload: IngestRequest) {
    const now = Date.now();
    if (
      payload.sentAt !== undefined &&
      Math.abs(now - payload.sentAt) > INGESTION_REQUEST_TTL_MS
    ) {
      return { accepted: 0, expired: true, receivedAt: now };
    }
    const transaction = this.db.transaction(() => {
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      const banned = this.db
        .query("SELECT banned_at FROM devices WHERE id=?")
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        .get(payload.device.id) as { banned_at: number | null } | null;
      if (banned?.banned_at) {
        return false;
      }
      this.db
        .query(
          "INSERT INTO devices(id,name,platform,last_seen) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,platform=excluded.platform,last_seen=excluded.last_seen"
        )
        .run(
          payload.device.id,
          payload.device.name,
          payload.device.platform,
          now
        );
      if (payload.requestId) {
        this.db
          .query("DELETE FROM ingestion_requests WHERE received_at<?")
          .run(now - INGESTION_REQUEST_TTL_MS);
        const inserted = this.db
          .query(
            "INSERT OR IGNORE INTO ingestion_requests(device_id,request_id,received_at) VALUES(?,?,?)"
          )
          .run(payload.device.id, payload.requestId, now);
        if (inserted.changes === 0) {
          return "replay" as const;
        }
      }
      const put = this.db.query(
        "INSERT INTO sessions(device_id,source_path,source_mtime_ms,source_size,session_id,project,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id,source_path,session_id) DO UPDATE SET source_mtime_ms=excluded.source_mtime_ms,source_size=excluded.source_size,project=excluded.project,updated_at=excluded.updated_at"
      );
      const deleteUsage = this.db.query(
        "DELETE FROM session_usage WHERE device_id=? AND source_path=? AND session_id=?"
      );
      const putUsage = this.usageInsertStatement();
      const updates =
        payload.sourceUpdates ??
        [...new Set(payload.sessions.map((session) => session.sourcePath))].map(
          (sourcePath) => ({ mode: "replace" as const, sourcePath })
        );
      for (const update of updates) {
        if (update.mode === "replace") {
          this.db
            .query("DELETE FROM sessions WHERE device_id=? AND source_path=?")
            .run(payload.device.id, update.sourcePath);
        } else {
          const remove = this.db.query(
            "DELETE FROM sessions WHERE device_id=? AND source_path=? AND session_id=?"
          );
          for (const sessionId of update.removedSessionIds ?? []) {
            remove.run(payload.device.id, update.sourcePath, sessionId);
          }
        }
      }
      for (const s of payload.sessions) {
        put.run(
          payload.device.id,
          s.sourcePath,
          s.sourceMtimeMs,
          s.sourceSize,
          s.sessionId,
          s.project ?? null,
          now
        );
        deleteUsage.run(payload.device.id, s.sourcePath, s.sessionId);
        for (const [index, message] of s.messages.entries()) {
          Store.insertUsage(
            putUsage,
            payload.device.id,
            s.sourcePath,
            s.sessionId,
            index,
            message
          );
        }
      }
    });
    const accepted = transaction();
    if (accepted === false) {
      return { accepted: 0, banned: true, receivedAt: now };
    }
    if (accepted === "replay") {
      return { accepted: 0, receivedAt: now, replayed: true };
    }
    return { accepted: payload.sessions.length, receivedAt: now };
  }

  sessions(
    query: string,
    deviceIds: string[] = [],
    agentNames: string[] = [],
    limit = 20,
    offset = 0,
    sessionSort: SessionSort = "lastSeen"
  ): SessionSummary[] {
    const deviceWhere = deviceIds.length
      ? `device_id IN (${deviceIds.map(() => "?").join(",")})`
      : "";
    const where = deviceWhere ? ` WHERE ${deviceWhere}` : "";
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const rows = this.db
      .query(
        `SELECT device_id,source_path,session_id,project FROM sessions${where}`
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .all(...deviceIds) as StoredSessionRow[];
    return rows
      .map((row) => this.summarizeSession(row))
      .filter(
        (session) =>
          (agentNames.length === 0 || agentNames.includes(session.client)) &&
          matchesSessionQuery(session, query)
      )
      .toSorted((a, b) => b[sessionSort] - a[sessionSort])
      .slice(offset, offset + limit);
  }

  session(id: string, deviceIds: string[] = []): SessionSummary | undefined {
    const identity = parseSessionApiId(id);
    if (
      !identity ||
      (deviceIds.length > 0 && !deviceIds.includes(identity.deviceId))
    ) {
      return undefined;
    }
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const row = this.db
      .query(
        "SELECT device_id,source_path,session_id,project FROM sessions WHERE device_id=? AND source_path=? AND session_id=?"
      )
      .get(
        identity.deviceId,
        identity.sourcePath,
        identity.sessionId
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      ) as StoredSessionRow | null;
    return row ? this.summarizeSession(row, true) : undefined;
  }

  summary(
    deviceIds: string[] = [],
    range: TimeRange = "month",
    includeAllDevices = false,
    sessionSort: SessionSort = "lastSeen"
  ): DashboardSummary {
    const where = deviceIds.length
      ? ` WHERE device_id IN (${deviceIds.map(() => "?").join(",")})`
      : "";
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const rows = this.db
      .query(
        `SELECT device_id,source_path,session_id,project FROM sessions${where}`
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .all(...deviceIds) as StoredSessionRow[];
    const rangeStart = Store.rangeStart(range);
    const messages: UsageMessage[] = [...this.usageForSessions(rows).values()]
      .flat()
      .filter((message) => {
        const timestampMs =
          Math.abs(message.timestamp) > 1_000_000_000_000
            ? message.timestamp
            : message.timestamp * 1000;
        return timestampMs >= rangeStart;
      });
    const core = summarize(messages);
    if (range === "day") {
      core.hourly = Store.hourlyBuckets(core.hourly);
    }
    const deviceFilter =
      includeAllDevices || deviceIds.length === 0
        ? ""
        : ` WHERE id IN (${deviceIds.map(() => "?").join(",")})`;
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const devices = this.db
      .query(
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
        `SELECT id,name,platform,last_seen as lastSeen FROM devices${deviceFilter} ORDER BY name`
      )
      .all(
        ...(includeAllDevices ? [] : deviceIds)
        // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      ) as DashboardSummary["devices"];
    const bySession = new Map<string, UsageMessage[]>();
    const byAgent = new Map<string, UsageMessage[]>();
    const byModel = new Map<string, UsageMessage[]>();
    const byProject = new Map<string, UsageMessage[]>();
    for (const message of messages) {
      appendGroup(bySession, message.sessionId, message);
      appendGroup(byAgent, message.client, message);
      if (totalTokens(message.tokens) > 0) {
        appendGroup(byModel, canonicalModelId(message.modelId), message);
      }
      const project = projectLabel(message);
      if (project) {
        appendGroup(byProject, project, message);
      }
    }
    const agentDetails = summarizeGroups(byAgent);
    const modelDetails = summarizeGroups(byModel);
    const projectDetails = summarizeGroups(byProject);
    const recentSessions = [...bySession]
      .map(([id, list]) => {
        const identity = parseSessionApiId(id);
        if (!identity) {
          throw new Error("Could not decode stored session identity");
        }
        return {
          client: list[0]?.client ?? "unknown",
          cost: list.reduce((value, message) => value + message.cost, 0),
          createdAt: Math.min(...list.map((message) => message.timestamp)),
          deviceId: identity.deviceId,
          id,
          lastSeen: Math.max(...list.map((message) => message.timestamp)),
          model: canonicalModelId(
            list.toSorted((a, b) => b.cost - a.cost)[0]?.modelId ?? "unknown"
          ),
          project: sessionProject(list),
          sessionId: identity.sessionId,
          sourcePath: identity.sourcePath,
          title: list.find((message) => message.sessionTitle?.trim())
            ?.sessionTitle,
          tokens: list.reduce(
            (value, message) => value + totalTokens(message.tokens),
            0
          ),
        };
      })
      .toSorted((a, b) => b[sessionSort] - a[sessionSort])
      .slice(0, 20);
    return {
      ...core,
      agentDetails,
      devices,
      modelDetails,
      projectDetails,
      recentSessions,
    };
  }

  private issueDashboardCredentials(
    deviceId: string,
    now: number
  ): DashboardCredentials {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessTokenExpiresAt = now + ACCESS_TOKEN_TTL_MS;
    const refreshTokenExpiresAt = now + REFRESH_TOKEN_TTL_MS;
    const insert = this.db.query(
      "INSERT INTO dashboard_tokens(token_hash,device_id,kind,created_at,expires_at) VALUES(?,?,?,?,?)"
    );
    insert.run(
      hashSecret(accessToken),
      deviceId,
      "access",
      now,
      accessTokenExpiresAt
    );
    insert.run(
      hashSecret(refreshToken),
      deviceId,
      "refresh",
      now,
      refreshTokenExpiresAt
    );
    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private usageInsertStatement() {
    return this.db.query(
      "INSERT INTO session_usage(device_id,source_path,session_id,message_index,client,model_id,provider_id,workspace_key,workspace_label,timestamp,date,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost,cost_source,duration_ms,message_count,agent,dedup_key,session_title,is_turn_start) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
  }

  private static insertUsage(
    statement: ReturnType<Database["query"]>,
    deviceId: string,
    sourcePath: string,
    sessionId: string,
    index: number,
    message: UsageMessage
  ): void {
    statement.run(
      deviceId,
      sourcePath,
      sessionId,
      index,
      message.client,
      message.modelId,
      message.providerId,
      message.workspaceKey ?? null,
      message.workspaceLabel ?? null,
      message.timestamp,
      message.date,
      message.tokens.input,
      message.tokens.output,
      message.tokens.cacheRead,
      message.tokens.cacheWrite,
      message.tokens.reasoning,
      message.cost,
      message.costSource,
      message.durationMs ?? null,
      message.messageCount,
      message.agent ?? null,
      message.dedupKey ?? null,
      cleanSessionTitle(message.sessionTitle) ?? null,
      message.isTurnStart ? 1 : 0
    );
  }

  private usageForSessions(
    rows: StoredSessionRow[]
  ): Map<string, UsageMessage[]> {
    const sessions = new Map(
      rows.map((row) => [
        `${row.device_id}\u0000${row.source_path}\u0000${row.session_id}`,
        row,
      ])
    );
    const messages = new Map<string, UsageMessage[]>();
    // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
    const usageRows = this.db
      .query(
        "SELECT * FROM session_usage ORDER BY device_id,source_path,session_id,message_index"
      )
      // SAFETY: bun:sqlite returns rows matching the explicitly selected columns and database schema.
      .all() as StoredUsageRow[];
    for (const usage of usageRows) {
      const key = `${usage.device_id}\u0000${usage.source_path}\u0000${usage.session_id}`;
      const session = sessions.get(key);
      if (!session) {
        continue;
      }
      const list = messages.get(key) ?? [];
      list.push({
        ...withProject(messageFromRow(usage), session.project),
        sessionId: sessionApiId(sessionIdentity(session)),
      });
      messages.set(key, list);
    }
    return messages;
  }

  private summarizeSession(
    row: StoredSessionRow,
    includeParts = false
  ): SessionSummary {
    const identity = sessionIdentity(row);
    const id = sessionApiId(identity);
    const key = `${row.device_id}\u0000${row.source_path}\u0000${row.session_id}`;
    const list = this.usageForSessions([row]).get(key) ?? [];
    const topModel = list.toSorted((a, b) => b.cost - a.cost)[0]?.modelId;
    const summary: SessionSummary = {
      client: list[0]?.client ?? "unknown",
      cost: list.reduce((value, message) => value + message.cost, 0),
      createdAt: list[0]
        ? Math.min(...list.map((message) => message.timestamp))
        : 0,
      deviceId: identity.deviceId,
      id,
      lastSeen: Math.max(
        0,
        ...list.map((message) => message.timestamp + (message.durationMs ?? 0))
      ),
      model: topModel ? canonicalModelId(topModel) : "unknown",
      project: sessionProject(list),
      sessionId: identity.sessionId,
      sourcePath: identity.sourcePath,
      title: list.find((message) => message.sessionTitle?.trim())?.sessionTitle,
      tokens: list.reduce(
        (value, message) => value + totalTokens(message.tokens),
        0
      ),
    };
    if (includeParts) {
      summary.parts = sessionParts(list);
    }
    return summary;
  }

  private static hourlyBuckets(
    hourly: DashboardSummary["hourly"]
  ): DashboardSummary["hourly"] {
    const values = new Map(hourly.map((point) => [point.date, point]));
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return Array.from({ length: 24 }, (_, hour) => {
      const date = `${day}T${pad(hour)}:00`;
      return values.get(date) ?? { cost: 0, date, tokens: 0 };
    });
  }

  private static rangeStart(range: TimeRange): number {
    const now = new Date();
    if (range === "all") {
      return Number.NEGATIVE_INFINITY;
    }
    if (range === "day") {
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      ).getTime();
    }
    if (range === "week") {
      return now.getTime() - 7 * 24 * 60 * 60 * 1000;
    }
    if (range === "month") {
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    }
    return new Date(now.getFullYear(), 0, 1).getTime();
  }
}
