import type {
  IngestRequest,
  SessionSnapshot,
  UsageMessage,
} from "../packages/shared/src/index.ts";

const TRACKER_CLIENTS = {
  "Claude Code": "claude",
  Codex: "codex",
  "GitHub Copilot": "copilot",
  OpenCode: "opencode",
  Pi: "pi",
} as const;

type DemoAgent = keyof typeof TRACKER_CLIENTS;

interface DemoSession {
  agent: DemoAgent;
  daysAgo: number;
  deviceId: string;
  model: string;
  project: string;
  title: string;
}

const DEMO_SESSIONS: DemoSession[] = [
  {
    agent: "Claude Code",
    daysAgo: 0,
    deviceId: "studio-mac",
    model: "claude-sonnet-4-5",
    project: "toktracker",
    title: "Polish dashboard filters",
  },
  {
    agent: "Codex",
    daysAgo: 0,
    deviceId: "work-laptop",
    model: "gpt-5.2-codex",
    project: "website",
    title: "Implement the pricing page",
  },
  {
    agent: "Pi",
    daysAgo: 1,
    deviceId: "studio-mac",
    model: "claude-opus-4-5",
    project: "api-gateway",
    title: "Review authentication middleware",
  },
  {
    agent: "GitHub Copilot",
    daysAgo: 1,
    deviceId: "work-laptop",
    model: "gpt-4.1",
    project: "mobile-app",
    title: "Fix offline sync regression",
  },
  {
    agent: "Claude Code",
    daysAgo: 2,
    deviceId: "studio-mac",
    model: "claude-sonnet-4-5",
    project: "toktracker",
    title: "Add session search",
  },
  {
    agent: "OpenCode",
    daysAgo: 3,
    deviceId: "linux-builder",
    model: "qwen3-coder",
    project: "infra",
    title: "Update deployment workflow",
  },
  {
    agent: "Codex",
    daysAgo: 4,
    deviceId: "work-laptop",
    model: "gpt-5.2-codex",
    project: "website",
    title: "Improve landing page performance",
  },
  {
    agent: "Claude Code",
    daysAgo: 5,
    deviceId: "studio-mac",
    model: "claude-sonnet-4-5",
    project: "api-gateway",
    title: "Trace slow API requests",
  },
  {
    agent: "GitHub Copilot",
    daysAgo: 6,
    deviceId: "work-laptop",
    model: "gpt-4.1",
    project: "mobile-app",
    title: "Build settings screen",
  },
  {
    agent: "Pi",
    daysAgo: 8,
    deviceId: "studio-mac",
    model: "claude-opus-4-5",
    project: "toktracker",
    title: "Plan weekly release",
  },
  {
    agent: "OpenCode",
    daysAgo: 10,
    deviceId: "linux-builder",
    model: "qwen3-coder",
    project: "infra",
    title: "Harden container build",
  },
  {
    agent: "Claude Code",
    daysAgo: 13,
    deviceId: "studio-mac",
    model: "claude-sonnet-4-5",
    project: "website",
    title: "Refine responsive navigation",
  },
  {
    agent: "Codex",
    daysAgo: 16,
    deviceId: "work-laptop",
    model: "gpt-5.2-codex",
    project: "api-gateway",
    title: "Add usage rate limits",
  },
  {
    agent: "GitHub Copilot",
    daysAgo: 20,
    deviceId: "work-laptop",
    model: "gpt-4.1",
    project: "mobile-app",
    title: "Improve accessibility labels",
  },
  {
    agent: "Claude Code",
    daysAgo: 24,
    deviceId: "studio-mac",
    model: "claude-haiku-4-5",
    project: "toktracker",
    title: "Refresh documentation",
  },
  {
    agent: "OpenCode",
    daysAgo: 29,
    deviceId: "linux-builder",
    model: "qwen3-coder",
    project: "infra",
    title: "Simplify CI cache",
  },
];

const DEVICES = {
  "linux-builder": { name: "build-runner", platform: "linux" },
  "studio-mac": { name: "Ben's Mac Studio", platform: "macos" },
  "work-laptop": { name: "Work MacBook Pro", platform: "macos" },
} as const;

const timestampFor = (daysAgo: number, hour: number): number => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
};

const dateFor = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-CA").format(timestamp);

const snapshotFor = (session: DemoSession, index: number): SessionSnapshot => {
  const sessionId = `demo-${index + 1}`;
  const startedAt = timestampFor(session.daysAgo, 9 + (index % 7));
  const tokens = 18_000 + index * 2750;
  const cost = Number(
    ((tokens / 1_000_000) * (index % 3 === 0 ? 12 : 5)).toFixed(3)
  );
  const message = (offset: number): UsageMessage => ({
    client: TRACKER_CLIENTS[session.agent],
    cost: offset === 0 ? cost : Number((cost * 0.35).toFixed(3)),
    costSource: index % 4 === 0 ? "providerReported" : "estimated",
    date: dateFor(startedAt + offset * 45 * 60 * 1000),
    isTurnStart: offset === 0,
    messageCount: 4 + (index % 5),
    modelId: session.model,
    providerId: session.agent.toLocaleLowerCase().replaceAll(" ", "-"),
    sessionId,
    sessionTitle: session.title,
    timestamp: startedAt + offset * 45 * 60 * 1000,
    tokens: {
      cacheRead: Math.round(tokens * 0.3),
      cacheWrite: Math.round(tokens * 0.05),
      input: Math.round(tokens * 0.45),
      output: Math.round(tokens * 0.2),
      reasoning: 0,
    },
    workspaceKey: session.project,
    workspaceLabel: session.project,
  });
  return {
    deviceId: session.deviceId,
    messages: [message(0), message(1)],
    project: session.project,
    sessionId,
    sourceMtimeMs: startedAt,
    sourcePath: `/demo/${session.agent.toLocaleLowerCase().replaceAll(" ", "-")}/${sessionId}.jsonl`,
    sourceSize: 2048 + index * 127,
  };
};

/** Creates a realistic, date-relative dataset for the local demo server. */
export const createDemoPayloads = (): IngestRequest[] => {
  const snapshotsByDevice = new Map<string, SessionSnapshot[]>();
  for (const [index, session] of DEMO_SESSIONS.entries()) {
    const snapshots = snapshotsByDevice.get(session.deviceId) ?? [];
    snapshots.push(snapshotFor(session, index));
    snapshotsByDevice.set(session.deviceId, snapshots);
  }
  return [...snapshotsByDevice].map(([id, sessions]) => ({
    // SAFETY: test and demo fixtures are constructed with the asserted application contract.
    device: { id, ...DEVICES[id as keyof typeof DEVICES] },
    sessions,
  }));
};
