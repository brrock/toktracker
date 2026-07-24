/* eslint-disable complexity, func-style, no-nested-ternary, require-unicode-regexp, sort-vars, typescript/no-explicit-any, typescript/no-non-null-assertion, unicorn/no-array-for-each, unicorn/no-nested-ternary */
// Dynamic OTEL records require schema probing; branches mirror tokscale precedence.
import { Database } from "bun:sqlite";

import type { TokenBreakdown, UsageMessage } from "@toktracker/shared";

import { inferProvider, normalizeWorkspace } from "./identity";
import { makeMessage, totalTokens } from "./model";

type Json = Record<string, any>;
const n = (v: unknown) => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x)
    ? Math.max(0, Math.trunc(x))
    : 0;
};
const lines = (text: string): Json[] =>
  text.split(/\r?\n/).flatMap((v) => {
    try {
      return [JSON.parse(v)];
    } catch {
      return [];
    }
  });
const stem = (path: string) =>
  path
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "") ?? "unknown";
export function normalizeCopilotTokens(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning: number
): TokenBreakdown {
  const cached = Math.min(Math.max(0, cacheRead), Math.max(0, input));
  return {
    cacheRead: Math.max(0, cacheRead),
    cacheWrite: Math.max(0, cacheWrite),
    input: Math.max(0, input) - cached,
    output: Math.max(0, output),
    reasoning: Math.max(0, reasoning),
  };
}
const provider = (model: string) => inferProvider(model) ?? "github-copilot";

export function parseCopilotVsCode(
  contents: string,
  sourcePath: string,
  workspaceUri?: string
): UsageMessage[] {
  const requests: Json[] = [];
  for (const row of lines(contents)) {
    if (row.kind === 0 && Array.isArray(row.v?.requests)) {
      requests.push(...row.v.requests);
    }
    if (row.kind === 2 && row.k?.[0] === "requests" && Array.isArray(row.v)) {
      requests.push(...row.v);
    }
  }
  const sessionId = stem(sourcePath),
    ws = normalizeWorkspace(workspaceUri?.replace(/^file:\/\//, ""));
  return requests.flatMap((req) => {
    const input = n(req.promptTokens ?? req.result?.metadata?.promptTokens),
      output = n(req.completionTokens ?? req.result?.metadata?.outputTokens);
    if (!input && !output) {
      return [];
    }
    const raw = typeof req.modelId === "string" ? req.modelId.trim() : "",
      resolved =
        typeof req.result?.metadata?.resolvedModel === "string"
          ? req.result.metadata.resolvedModel.trim()
          : "";
    if (!resolved && !raw.startsWith("copilot/")) {
      return [];
    }
    const model = resolved || raw.replace(/^copilot\//, "") || "auto";
    const reasoning = (req.result?.metadata?.toolCallRounds ?? []).reduce(
      (sum: number, r: Json) => sum + n(r?.thinking?.tokens),
      0
    );
    return [
      makeMessage({
        client: "copilot",
        cost: 0,
        dedupKey: `copilot-vscode:${sessionId}:${n(req.timestamp)}`,
        modelId: model,
        providerId: provider(model),
        sessionId,
        timestamp: n(req.timestamp),
        tokens: { cacheRead: 0, cacheWrite: 0, input, output, reasoning },
        workspaceKey: ws.key,
        workspaceLabel: ws.label,
      }),
    ];
  });
}

function parseTime(value: unknown): number {
  if (typeof value === "number") {
    return value < 1e10 ? value * 1000 : value;
  }
  if (typeof value !== "string") {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1e10 ? numeric * 1000 : numeric;
  }
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
export function parseCopilotDesktopSqlite(
  path: string,
  eventsBySession: Record<string, string> = {}
): UsageMessage[] {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, strict: true });
  } catch {
    return [];
  }
  let rows: Json[];
  try {
    rows = db
      .query(
        `SELECT id,model,total_input_tokens,total_output_tokens,total_cached_tokens,total_reasoning_tokens,created_at FROM sessions WHERE total_input_tokens>0 OR total_output_tokens>0 OR total_cached_tokens>0 OR total_reasoning_tokens>0`
      )
      .all() as Json[];
  } catch {
    db.close();
    return [];
  }
  db.close();
  return rows.map((row) => {
    let cwd: string | undefined, eventModel: string | undefined;
    for (const event of lines(eventsBySession[row.id] ?? "")) {
      if (event.type === "session.start" && !cwd) {
        cwd = event.data?.context?.cwd;
      }
      if (
        event.type === "session.model_change" &&
        event.data?.newModel &&
        event.data.newModel !== "auto"
      ) {
        eventModel = event.data.newModel;
      }
    }
    const model = (eventModel ?? row.model)?.trim() || "auto",
      ws = normalizeWorkspace(cwd);
    return makeMessage({
      client: "copilot",
      cost: 0,
      dedupKey: `copilot-desktop:${row.id}`,
      modelId: model,
      providerId: provider(model),
      sessionId: row.id,
      timestamp: parseTime(row.created_at),
      tokens: normalizeCopilotTokens(
        n(row.total_input_tokens),
        n(row.total_output_tokens),
        n(row.total_cached_tokens),
        0,
        n(row.total_reasoning_tokens)
      ),
      workspaceKey: ws.key,
      workspaceLabel: ws.label,
    });
  });
}

type Source = "chat" | "inference" | "turn" | "summary";
interface Candidate {
  source: Source;
  trace?: string;
  response?: string;
  message: UsageMessage;
  inclusiveInput: number;
}
const attr = (a: Json, keys: string[]) =>
  keys
    .map((k) => a[k])
    .find((v) => typeof v === "string" && v.trim())
    ?.trim();
const trace = (r: Json) => {
  const value = r.traceId ?? r.spanContext?.traceId;
  return typeof value === "string" && value && !/^0+$/.test(value)
    ? value
    : undefined;
};
const span = (r: Json) => {
  const value = r.spanId ?? r.spanContext?.spanId;
  return typeof value === "string" && value && !/^0+$/.test(value)
    ? value
    : undefined;
};
const isSpan = (r: Json) =>
  r.type === "span" ||
  (r.type === undefined &&
    typeof r.name === "string" &&
    (r.spanId ||
      r.traceId ||
      r.startTime ||
      r.endTime ||
      r.duration ||
      r.kind));
const timePart = (v: any): number | undefined => {
  if (Array.isArray(v)) {
    const sec = Number(v[0]),
      nano = Number(v[1] ?? 0);
    return Number.isFinite(sec)
      ? Math.trunc(sec * 1000 + nano / 1e6)
      : undefined;
  }
  if (typeof v === "string") {
    return parseTime(v);
  }
  if (typeof v === "number") {
    return v > 1e15 ? Math.trunc(v / 1e6) : v < 1e10 ? v * 1000 : v;
  }
};
const duration = (r: Json) => {
  const s = timePart(r.startTime),
    e = timePart(r.endTime);
  if (s !== undefined && e !== undefined && e > s) {
    return e - s;
  }
  const d = r.duration;
  if (Array.isArray(d)) {
    return Math.trunc(Number(d[0]) * 1000 + Number(d[1] ?? 0) / 1e6);
  }
  return typeof d === "number" ? Math.trunc(d / 1e6) : undefined;
};

export function parseCopilotOtel(
  contents: string,
  sourcePath: string,
  fallback = Date.now()
): UsageMessage[] {
  const records = lines(contents),
    context = new Map<
      string,
      { model?: string; session?: string; agent?: string }
    >();
  for (const r of records) {
    const t = trace(r),
      a = r.attributes;
    if (!t || !a) {
      continue;
    }
    const c = context.get(t) ?? {};
    c.model ??= attr(a, ["gen_ai.response.model", "gen_ai.request.model"]);
    c.session ??= attr(a, [
      "gen_ai.conversation.id",
      "copilot_chat.session_id",
      "copilot_chat.chat_session_id",
      "session.id",
      "github.copilot.interaction_id",
      "gen_ai.response.id",
    ]);
    c.agent ??= attr(a, ["gen_ai.agent.id"]);
    context.set(t, c);
  }
  const candidates: Candidate[] = [];
  records.forEach((r, index) => {
    const a = r.attributes;
    if (!a) {
      return;
    }
    const spanRecord = isSpan(r),
      body = r.body ?? r._body,
      operation = a["gen_ai.operation.name"];
    let source: Source | undefined;
    if (spanRecord && (operation === "chat" || r.name?.startsWith("chat "))) {
      source = "chat";
    } else if (
      !spanRecord &&
      (a["event.name"] === "gen_ai.client.inference.operation.details" ||
        body?.startsWith("GenAI inference:"))
    ) {
      source = "inference";
    } else if (
      !spanRecord &&
      (a["event.name"] === "copilot_chat.agent.turn" ||
        body?.startsWith("copilot_chat.agent.turn"))
    ) {
      source = "turn";
    } else if (
      spanRecord &&
      (operation === "invoke_agent" || r.name?.startsWith("invoke_agent "))
    ) {
      source = "summary";
    }
    if (!source) {
      return;
    }
    const input = n(a["gen_ai.usage.input_tokens"]),
      output = n(a["gen_ai.usage.output_tokens"]),
      cacheRead = n(
        a["gen_ai.usage.cache_read.input_tokens"] ??
          a["gen_ai.usage.cache_read_input_tokens"]
      ),
      cacheWrite = n(
        a["gen_ai.usage.cache_write.input_tokens"] ??
          a["gen_ai.usage.cache_creation.input_tokens"] ??
          a["gen_ai.usage.cache_write_input_tokens"]
      ),
      reasoning = n(
        a["gen_ai.usage.reasoning.output_tokens"] ??
          a["gen_ai.usage.reasoning_tokens"]
      ),
      tokens = normalizeCopilotTokens(
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning
      );
    if (!totalTokens(tokens)) {
      return;
    }
    const t = trace(r),
      ctx = t ? context.get(t) : undefined,
      model =
        attr(a, ["gen_ai.response.model", "gen_ai.request.model"]) ??
        ctx?.model ??
        "unknown",
      sessionId =
        attr(a, [
          "gen_ai.conversation.id",
          "copilot_chat.session_id",
          "copilot_chat.chat_session_id",
          "session.id",
          "github.copilot.interaction_id",
          "gen_ai.response.id",
        ]) ??
        ctx?.session ??
        t ??
        "unknown-session",
      start =
        timePart(r.startTime) ??
        timePart(
          r.hrTime ?? r._hrTime ?? r.time ?? r.timestamp ?? r.timeUnixNano
        ) ??
        fallback,
      sp = span(r);
    const key =
      source === "turn"
        ? `agent-turn:${t ?? sessionId}:${a["turn.index"] ?? a["copilot_chat.turn.index"] ?? `idx-${index}`}`
        : source === "inference"
          ? t && sp
            ? `log:${t}:${sp}`
            : `log:${sessionId}:${start}:${index}`
          : t && sp
            ? `${t}:${sp}`
            : sp
              ? `span:${sessionId}:${sp}`
              : `span:${sessionId}:${start}:${index}`;
    candidates.push({
      inclusiveInput: input,
      message: makeMessage({
        agent: attr(a, ["gen_ai.agent.id"]) ?? ctx?.agent,
        client: "copilot",
        cost: 0,
        dedupKey: key,
        durationMs: duration(r),
        modelId: model,
        providerId: provider(model),
        sessionId,
        timestamp: start,
        tokens,
      }),
      response: attr(a, ["gen_ai.response.id"]),
      source,
      trace: t,
    });
  });
  const rank: Record<Source, number> = {
    chat: 4,
    inference: 3,
    summary: 1,
    turn: 2,
  };
  const filtered = candidates.filter(
    (c) =>
      !candidates.some(
        (other) =>
          other !== c &&
          rank[other.source] > rank[c.source] &&
          ((c.trace && other.trace === c.trace) ||
            (c.response && other.response === c.response))
      )
  );
  const merged = new Map<string, Candidate>();
  for (const c of filtered) {
    const old = merged.get(c.message.dedupKey!);
    if (!old) {
      merged.set(c.message.dedupKey!, c);
      continue;
    }
    old.inclusiveInput = Math.max(old.inclusiveInput, c.inclusiveInput);
    old.message.tokens = normalizeCopilotTokens(
      old.inclusiveInput,
      Math.max(old.message.tokens.output, c.message.tokens.output),
      Math.max(old.message.tokens.cacheRead, c.message.tokens.cacheRead),
      Math.max(old.message.tokens.cacheWrite, c.message.tokens.cacheWrite),
      Math.max(old.message.tokens.reasoning, c.message.tokens.reasoning)
    );
    old.message.timestamp = Math.min(
      old.message.timestamp,
      c.message.timestamp
    );
    old.message.durationMs =
      Math.max(old.message.durationMs ?? 0, c.message.durationMs ?? 0) ||
      undefined;
  }
  return [...merged.values()].map((c) => c.message);
}
