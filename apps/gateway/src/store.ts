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

const withProject = (
  message: UsageMessage,
  storedProject: string | null
): UsageMessage => ({
  ...message,
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
    `);
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
          JSON.stringify(s.messages),
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
    limit = 20
  ): SessionSummary[] {
    const deviceWhere = deviceIds.length
      ? `device_id IN (${deviceIds.map(() => "?").join(",")})`
      : "";
    const where = deviceWhere ? ` WHERE ${deviceWhere}` : "";
    const rows = this.db
      .query(`SELECT session_id,project,messages_json FROM sessions${where}`)
      .all(...deviceIds) as {
      session_id: string;
      project: string | null;
      messages_json: string;
    }[];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const bySession = new Map<string, UsageMessage[]>();
    for (const row of rows) {
      for (const message of JSON.parse(row.messages_json) as UsageMessage[]) {
        appendGroup(
          bySession,
          message.sessionId,
          withProject(message, row.project)
        );
      }
    }
    return [...bySession]
      .map(([id, list]) => ({
        client: list[0]?.client ?? "unknown",
        cost: list.reduce((value, message) => value + message.cost, 0),
        id,
        lastSeen: Math.max(...list.map((message) => message.timestamp)),
        model:
          list.toSorted((a, b) => b.cost - a.cost)[0]?.modelId ?? "unknown",
        project: sessionProject(list),
        title: list.find((message) => message.sessionTitle?.trim())
          ?.sessionTitle,
        tokens: list.reduce(
          (value, message) => value + totalTokens(message.tokens),
          0
        ),
      }))
      .filter(
        (session) =>
          (agentNames.length === 0 || agentNames.includes(session.client)) &&
          [
            session.id,
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
      .slice(0, limit);
  }

  session(
    sessionId: string,
    deviceIds: string[] = []
  ): SessionSummary | undefined {
    return this.sessions(sessionId, deviceIds, []).find(
      (session) => session.id === sessionId
    );
  }

  summary(
    deviceIds: string[] = [],
    range: TimeRange = "month"
  ): DashboardSummary {
    const where = deviceIds.length
      ? ` WHERE device_id IN (${deviceIds.map(() => "?").join(",")})`
      : "";
    const rows = this.db
      .query(
        `SELECT device_id,session_id,project,messages_json FROM sessions${where}`
      )
      .all(...deviceIds) as {
      device_id: string;
      session_id: string;
      project: string | null;
      messages_json: string;
    }[];
    const rangeStart = Store.rangeStart(range);
    const messages: UsageMessage[] = rows
      .flatMap((row) =>
        (JSON.parse(row.messages_json) as UsageMessage[]).map((message) =>
          withProject(message, row.project)
        )
      )
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
    const devices = this.db
      .query(
        "SELECT id,name,platform,last_seen as lastSeen FROM devices ORDER BY name"
      )
      .all() as DashboardSummary["devices"];
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
      .map(([id, list]) => ({
        client: list[0]?.client ?? "unknown",
        cost: list.reduce((v, m) => v + m.cost, 0),
        id,
        lastSeen: Math.max(...list.map((m) => m.timestamp)),
        model:
          list.toSorted((a, b) => b.cost - a.cost)[0]?.modelId ?? "unknown",
        project: sessionProject(list),
        title: list.find((message) => message.sessionTitle?.trim())
          ?.sessionTitle,
        tokens: list.reduce((v, m) => v + totalTokens(m.tokens), 0),
      }))
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
