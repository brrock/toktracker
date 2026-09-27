import type { SessionSummary } from "@toktracker/shared";

import type { Row, Tables } from "./contract";

interface UsageEntry {
  cost: number;
  name: string;
  tokens: number;
}

interface TimePoint {
  cost: number;
  date: string;
  tokens: number;
}

/** The data a view can expose to queries. */
export interface QuerySource {
  agents?: readonly UsageEntry[];
  daily?: readonly TimePoint[];
  hourly?: readonly TimePoint[];
  models?: readonly UsageEntry[];
  projects?: readonly UsageEntry[];
  sessions?: readonly SessionSummary[];
}

const usageRows = (entries: readonly UsageEntry[]): Row[] =>
  entries.map((entry) => ({
    cost: entry.cost,
    name: entry.name,
    tokens: entry.tokens,
  }));

const isoTime = (timestamp: number): string | null =>
  timestamp > 0 ? new Date(timestamp).toISOString() : null;

const cache = new WeakMap<QuerySource, Tables>();

/**
 * Converts a view's data into the documented query tables (see TABLES in
 * contract.ts), copying only whitelisted fields.
 */
export const buildTables = (source: QuerySource): Tables => {
  const known = cache.get(source);
  if (known) {
    return known;
  }
  const tables: Tables = {};
  if (source.daily) {
    tables.daily = source.daily.map((point) => ({
      cost: point.cost,
      date: point.date,
      tokens: point.tokens,
    }));
  }
  if (source.hourly?.length) {
    tables.hourly = source.hourly.map((point) => ({
      cost: point.cost,
      hour: point.date,
      tokens: point.tokens,
    }));
  }
  if (source.agents) {
    tables.agents = usageRows(source.agents);
  }
  if (source.models) {
    tables.models = usageRows(source.models);
  }
  if (source.projects) {
    tables.projects = usageRows(source.projects);
  }
  if (source.sessions) {
    tables.sessions = source.sessions.map((session) => ({
      agent: session.client,
      cost: session.cost,
      created_at: isoTime(session.createdAt),
      id: session.id,
      last_seen: isoTime(session.lastSeen),
      model: session.model,
      project: session.project,
      title: session.title ?? session.sessionId,
      tokens: session.tokens,
    }));
  }
  cache.set(source, tables);
  return tables;
};
