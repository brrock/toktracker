import { Database } from "bun:sqlite";

import type {
  DashboardSummary,
  IngestRequest,
  SessionSummary,
  TimeRange,
  UsageDetail,
  UsageMessage,
} from "@toktracker/shared";
import {
  canonicalModelId,
  isHermesMessage,
  summarize,
  totalTokens,
} from "@toktracker/token-calc";

const pad = (value: number): string => value.toString().padStart(2, "0");
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
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

interface StoredSessionRow {
  device_id: string;
  source_path: string;
  session_id: string;
  project: string | null;
  messages_json: string;
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

const parseSessionApiId = (id: string): SessionIdentity | undefined => {
  try {
    const value = JSON.parse(
      Buffer.from(id, "base64url").toString()
    ) as unknown;
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const identity = value as Partial<SessionIdentity>;
    return typeof identity.deviceId === "string" &&
      typeof identity.sourcePath === "string" &&
      typeof identity.sessionId === "string"
      ? (identity as SessionIdentity)
      : undefined;
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

const sessionProject = (messages: UsageMessage[]): string => {
  const projectMessage = messages.find((message) => !isHermesMessage(message));
  if (!projectMessage) {
    return "No project";
  }
  return projectMessage.workspaceLabel ?? "Unknown project";
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
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (device_id TEXT NOT NULL, source_path TEXT NOT NULL, source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL, session_id TEXT NOT NULL, project TEXT, messages_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(device_id, source_path, session_id), FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS dashboard_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_pairing_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_tokens (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(device_id) REFERENCES dashboard_devices(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS dashboard_tokens_device ON dashboard_tokens(device_id);
    `);
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
    const primaryKey = (
      this.db.query("PRAGMA table_info(sessions)").all() as {
        name: string;
        pk: number;
      }[]
    )
      .filter((column) => column.pk > 0)
      .toSorted((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    if (primaryKey.join(",") === "device_id,source_path") {
      this.db.exec(
        "ALTER TABLE sessions RENAME TO sessions_v1; CREATE TABLE sessions (device_id TEXT NOT NULL, source_path TEXT NOT NULL, source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL, session_id TEXT NOT NULL, project TEXT, messages_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(device_id, source_path, session_id), FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE); INSERT INTO sessions SELECT * FROM sessions_v1; DROP TABLE sessions_v1;"
      );
    }
  }

  close(): void {
    this.db.close();
  }

  createDashboardPairingCode(ttlMs = PAIRING_CODE_TTL_MS): {
    code: string;
    expiresAt: number;
  } {
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
      const pairingCode = this.db
        .query(
          "SELECT code_hash FROM dashboard_pairing_codes WHERE code_hash=? AND expires_at>?"
        )
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
    const token = this.db
      .query(
        "SELECT device_id FROM dashboard_tokens WHERE token_hash=? AND kind='access' AND expires_at>?"
      )
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
      const token = this.db
        .query(
          "SELECT device_id FROM dashboard_tokens WHERE token_hash=? AND kind='refresh' AND expires_at>?"
        )
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
    const token = this.db
      .query(
        "SELECT device_id FROM dashboard_tokens WHERE token_hash=? AND kind='refresh'"
      )
      .get(hashSecret(refreshToken)) as { device_id: string } | null;
    return token ? this.revokeDashboardDevice(token.device_id) : false;
  }

  dashboardDevices(): DashboardDevice[] {
    return this.db
      .query(
        "SELECT id,name,created_at as createdAt,last_seen as lastSeen FROM dashboard_devices ORDER BY last_seen DESC"
      )
      .all() as DashboardDevice[];
  }

  revokeDashboardDevice(deviceId: string): boolean {
    return (
      this.db.query("DELETE FROM dashboard_devices WHERE id=?").run(deviceId)
        .changes > 0
    );
  }

  ingest(payload: IngestRequest) {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
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
      const put = this.db.query(
        "INSERT INTO sessions(device_id,source_path,source_mtime_ms,source_size,session_id,project,messages_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,source_path,session_id) DO UPDATE SET source_mtime_ms=excluded.source_mtime_ms,source_size=excluded.source_size,project=excluded.project,messages_json=excluded.messages_json,updated_at=excluded.updated_at"
      );
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
          JSON.stringify(
            s.messages.map((message) => ({
              ...message,
              sessionTitle: cleanSessionTitle(message.sessionTitle),
            }))
          ),
          now
        );
      }
    });
    transaction();
    return { accepted: payload.sessions.length, receivedAt: now };
  }

  sessions(
    query: string,
    deviceIds: string[] = [],
    agentNames: string[] = [],
    limit = 20,
    offset = 0
  ): SessionSummary[] {
    const deviceWhere = deviceIds.length
      ? `device_id IN (${deviceIds.map(() => "?").join(",")})`
      : "";
    const where = deviceWhere ? ` WHERE ${deviceWhere}` : "";
    const rows = this.db
      .query(
        `SELECT device_id,source_path,session_id,project,messages_json FROM sessions${where}`
      )
      .all(...deviceIds) as StoredSessionRow[];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return rows
      .map((row) => Store.summarizeSession(row))
      .filter(
        (session) =>
          (agentNames.length === 0 || agentNames.includes(session.client)) &&
          [
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
            .toLocaleLowerCase()
            .includes(normalizedQuery)
      )
      .toSorted((a, b) => b.lastSeen - a.lastSeen)
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
    const row = this.db
      .query(
        "SELECT device_id,source_path,session_id,project,messages_json FROM sessions WHERE device_id=? AND source_path=? AND session_id=?"
      )
      .get(
        identity.deviceId,
        identity.sourcePath,
        identity.sessionId
      ) as StoredSessionRow | null;
    return row ? Store.summarizeSession(row) : undefined;
  }

  summary(
    deviceIds: string[] = [],
    range: TimeRange = "month",
    includeAllDevices = false
  ): DashboardSummary {
    const where = deviceIds.length
      ? ` WHERE device_id IN (${deviceIds.map(() => "?").join(",")})`
      : "";
    const rows = this.db
      .query(
        `SELECT device_id,source_path,session_id,project,messages_json FROM sessions${where}`
      )
      .all(...deviceIds) as StoredSessionRow[];
    const rangeStart = Store.rangeStart(range);
    const messages: UsageMessage[] = rows
      .flatMap((row) => {
        const id = sessionApiId(sessionIdentity(row));
        return (JSON.parse(row.messages_json) as UsageMessage[]).map(
          (message) => ({
            ...withProject(message, row.project),
            sessionId: id,
          })
        );
      })
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
    const devices = this.db
      .query(
        `SELECT id,name,platform,last_seen as lastSeen FROM devices${deviceFilter} ORDER BY name`
      )
      .all(
        ...(includeAllDevices ? [] : deviceIds)
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
      if (!isHermesMessage(message)) {
        appendGroup(
          byProject,
          message.workspaceLabel ?? "Unknown project",
          message
        );
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
          deviceId: identity.deviceId,
          id,
          lastSeen: Math.max(...list.map((message) => message.timestamp)),
          model:
            list.toSorted((a, b) => b.cost - a.cost)[0]?.modelId ?? "unknown",
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
      .toSorted((a, b) => b.lastSeen - a.lastSeen)
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

  private static summarizeSession(row: StoredSessionRow): SessionSummary {
    const identity = sessionIdentity(row);
    const id = sessionApiId(identity);
    const list = (JSON.parse(row.messages_json) as UsageMessage[]).map(
      (message) => ({ ...withProject(message, row.project), sessionId: id })
    );
    return {
      client: list[0]?.client ?? "unknown",
      cost: list.reduce((value, message) => value + message.cost, 0),
      deviceId: identity.deviceId,
      id,
      lastSeen: Math.max(...list.map((message) => message.timestamp)),
      model: list.toSorted((a, b) => b.cost - a.cost)[0]?.modelId ?? "unknown",
      project: sessionProject(list),
      sessionId: identity.sessionId,
      sourcePath: identity.sourcePath,
      title: list.find((message) => message.sessionTitle?.trim())?.sessionTitle,
      tokens: list.reduce(
        (value, message) => value + totalTokens(message.tokens),
        0
      ),
    };
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
