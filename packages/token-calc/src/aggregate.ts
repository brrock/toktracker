import type {
  DashboardSummary,
  TimeSeriesPoint,
  UsageMessage,
} from "@toktracker/shared";

import { canonicalModelId, totalTokens } from "./model";

const pad = (value: number): string => value.toString().padStart(2, "0");

const localHour = (timestamp: number): string => {
  const timestampMs =
    Math.abs(timestamp) > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
};

export const isHermesMessage = (message: UsageMessage): boolean => {
  const client = message.client.trim().toLocaleLowerCase();
  const agent = message.agent?.trim().toLocaleLowerCase();
  return (
    client === "hermes" ||
    client === "hermes agent" ||
    agent === "hermes" ||
    agent === "hermes agent"
  );
};

export const projectLabel = (message: UsageMessage): string | undefined => {
  if (isHermesMessage(message)) {
    return undefined;
  }
  const label = message.workspaceLabel?.trim();
  if (!label || label.toLocaleLowerCase() === "unknown project") {
    return undefined;
  }
  return label;
};

const add = <T extends { tokens: number; cost: number }>(
  map: Map<string, T>,
  key: string,
  next: T
): void => {
  const old = map.get(key);
  if (old) {
    old.tokens += next.tokens;
    old.cost += next.cost;
  } else {
    map.set(key, next);
  }
};

export const summarize = (
  messages: UsageMessage[]
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
    add(daily, message.date, {
      cost: message.cost,
      date: message.date,
      tokens: amount,
    });
    add(hourly, localHour(message.timestamp), {
      cost: message.cost,
      date: localHour(message.timestamp),
      tokens: amount,
    });
    add(agents, message.client, {
      cost: message.cost,
      name: message.client,
      tokens: amount,
    });
    if (amount > 0) {
      const model = canonicalModelId(message.modelId);
      add(models, model, { cost: message.cost, name: model, tokens: amount });
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
      const timestampMs =
        Math.abs(message.timestamp) > 1_000_000_000_000
          ? message.timestamp
          : message.timestamp * 1000;
      item.lastSeen = Math.max(item.lastSeen, timestampMs);
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
