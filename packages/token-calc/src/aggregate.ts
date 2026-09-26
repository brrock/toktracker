import type {
  DashboardSummary,
  TimeSeriesPoint,
  UsageMessage,
} from "@toktracker/shared";

import { canonicalModelId, totalTokens } from "./model";

const pad = (value: number): string => value.toString().padStart(2, "0");

const MILLISECOND_TIMESTAMP_THRESHOLD = 1_000_000_000_000;
// Every time zone offset in use is a multiple of 15 minutes, so all
// timestamps inside one 15-minute slot share a local hour label.
const LOCAL_HOUR_SLOT_MS = 15 * 60 * 1000;
const MAX_MEMO_ENTRIES = 100_000;

const timestampMilliseconds = (timestamp: number): number =>
  Math.abs(timestamp) > MILLISECOND_TIMESTAMP_THRESHOLD
    ? timestamp
    : timestamp * 1000;

const boundedSet = <Value>(
  map: Map<string, Value>,
  key: string,
  value: Value
): Value => {
  if (map.size >= MAX_MEMO_ENTRIES) {
    map.clear();
  }
  map.set(key, value);
  return value;
};

const localHourLabels = new Map<string, string>();
const localHour = (timestamp: number): string => {
  const timestampMs = timestampMilliseconds(timestamp);
  const slot = String(Math.floor(timestampMs / LOCAL_HOUR_SLOT_MS));
  const cached = localHourLabels.get(slot);
  if (cached !== undefined) {
    return cached;
  }
  const date = new Date(timestampMs);
  return boundedSet(
    localHourLabels,
    slot,
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
  );
};

const HERMES_NAMES = new Set(["hermes", "hermes agent"]);
const hermesClients = new Map<string, boolean>();

// Called several times per message while building dashboard summaries.
// Locale-aware lowercasing dominated summary time, and the distinct
// client/agent pairs are few, so memoize the plain-ASCII comparison.
export const isHermesMessage = (message: UsageMessage): boolean => {
  const key = `${message.client}\u0000${message.agent ?? ""}`;
  const cached = hermesClients.get(key);
  if (cached !== undefined) {
    return cached;
  }
  return boundedSet(
    hermesClients,
    key,
    HERMES_NAMES.has(message.client.trim().toLowerCase()) ||
      HERMES_NAMES.has(message.agent?.trim().toLowerCase() ?? "")
  );
};

const UNKNOWN_PROJECT = "unknown project";

export const projectLabel = (message: UsageMessage): string | undefined => {
  if (isHermesMessage(message)) {
    return undefined;
  }
  const label = message.workspaceLabel?.trim();
  if (
    !label ||
    (label.length === UNKNOWN_PROJECT.length &&
      label.toLowerCase() === UNKNOWN_PROJECT)
  ) {
    return undefined;
  }
  return label;
};

const add = <T extends { tokens: number; cost: number }>(
  map: Map<string, T>,
  key: string,
  tokens: number,
  cost: number,
  create: () => T
): void => {
  const old = map.get(key);
  if (old) {
    old.tokens += tokens;
    old.cost += cost;
  } else {
    map.set(key, create());
  }
};

export interface SummarizeOptions {
  /** Hourly buckets are only charted for a single day; skip them otherwise. */
  hourly?: boolean;
}

export const summarize = (
  messages: UsageMessage[],
  options: SummarizeOptions = {}
): Omit<
  DashboardSummary,
  | "agentDetails"
  | "devices"
  | "modelDetails"
  | "projectDetails"
  | "recentSessions"
> => {
  const daily = new Map<string, TimeSeriesPoint>();
  const hourly = new Map<string, TimeSeriesPoint>();
  const agents = new Map<
    string,
    { name: string; tokens: number; cost: number }
  >();
  const models = new Map<
    string,
    { name: string; tokens: number; cost: number }
  >();
  const projects = new Map<
    string,
    {
      name: string;
      tokens: number;
      cost: number;
      sessions: Set<string>;
      lastSeen: number;
    }
  >();
  let cost = 0,
    count = 0,
    estimatedCost = 0,
    reportedCost = 0,
    tokens = 0,
    unpricedTokens = 0;
  const sessions = new Set<string>();
  const includeHourly = options.hourly ?? true;
  for (const message of messages) {
    const amount = totalTokens(message.tokens);
    tokens += amount;
    cost += Math.max(0, message.cost);
    if (message.costSource === "providerReported") {
      reportedCost += Math.max(0, message.cost);
    } else if (message.costSource === "estimated") {
      estimatedCost += Math.max(0, message.cost);
    } else {
      unpricedTokens += amount;
    }
    count += Math.max(0, message.messageCount);
    sessions.add(message.sessionId);
    add(daily, message.date, amount, message.cost, () => ({
      cost: message.cost,
      date: message.date,
      tokens: amount,
    }));
    if (includeHourly) {
      const hour = localHour(message.timestamp);
      add(hourly, hour, amount, message.cost, () => ({
        cost: message.cost,
        date: hour,
        tokens: amount,
      }));
    }
    add(agents, message.client, amount, message.cost, () => ({
      cost: message.cost,
      name: message.client,
      tokens: amount,
    }));
    if (amount > 0) {
      const model = canonicalModelId(message.modelId);
      add(models, model, amount, message.cost, () => ({
        cost: message.cost,
        name: model,
        tokens: amount,
      }));
    }
    const project = projectLabel(message);
    if (project) {
      const item = projects.get(project) ?? {
        cost: 0,
        lastSeen: 0,
        name: project,
        sessions: new Set<string>(),
        tokens: 0,
      };
      item.tokens += amount;
      item.cost += message.cost;
      item.lastSeen = Math.max(
        item.lastSeen,
        timestampMilliseconds(message.timestamp)
      );
      item.sessions.add(message.sessionId);
      projects.set(project, item);
    }
  }
  return {
    agents: [...agents.values()].toSorted((a, b) => b.tokens - a.tokens),
    daily: [...daily.values()].toSorted((a, b) => a.date.localeCompare(b.date)),
    hourly: [...hourly.values()].toSorted((a, b) =>
      a.date.localeCompare(b.date)
    ),
    models: [...models.values()].toSorted((a, b) => b.tokens - a.tokens),
    projects: [...projects.values()]
      .map((p) => ({ ...p, sessions: p.sessions.size }))
      .toSorted((a, b) => b.lastSeen - a.lastSeen),
    totals: {
      cost,
      estimatedCost,
      messages: count,
      reportedCost,
      sessions: sessions.size,
      tokens,
      unpricedTokens,
    },
  };
};
