/* eslint-disable complexity, func-style, no-nested-ternary, no-use-before-define, prefer-destructuring, prefer-named-capture-group, require-unicode-regexp, sort-vars, typescript/no-explicit-any, typescript/no-non-null-assertion, unicorn/consistent-function-scoping */
// Stateful ports intentionally retain tokscale's branch structure for parity.
import type { TokenBreakdown, UsageMessage } from "@toktracker/shared";

import { normalizeWorkspace } from "./identity";
import { makeMessage, zeroTokens } from "./model";

type Json = Record<string, any>;
const n = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
const stamp = (value: unknown, fallback: number): number =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : fallback;
const stem = (path: string) =>
  path
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "") || "unknown";
const conversationTitle = (content: unknown): string | undefined => {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.find((part) => typeof part?.text === "string")?.text
        : undefined;
  if (typeof text !== "string") {
    return undefined;
  }
  const title = text.replaceAll(/\s+/gu, " ").trim();
  return title ? title.slice(0, 160) : undefined;
};

export type SupportedClient = "claude" | "codex";

export function parseSession(
  client: SupportedClient,
  contents: string,
  sourcePath: string,
  fallbackTimestamp = Date.now()
): UsageMessage[] {
  return client === "claude"
    ? parseClaude(contents, sourcePath, fallbackTimestamp)
    : parseCodex(contents, sourcePath, fallbackTimestamp);
}

/** Port of tokscale-core's primary Claude Code assistant-usage lane. */
export function parseClaude(
  contents: string,
  sourcePath: string,
  fallbackTimestamp = Date.now()
): UsageMessage[] {
  const messages: UsageMessage[] = [];
  const seen = new Map<string, number>();
  let sessionId = stem(sourcePath),
    sessionTitle: string | undefined,
    workspace: string | undefined;
  let pendingTurn = false;
  let requestStart: number | undefined;
  for (const line of contents.split(/\r?\n/)) {
    let row: Json;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.cwd === "string") {
      workspace = row.cwd;
    }
    if (row.isSidechain && typeof row.sessionId === "string") {
      sessionId = row.sessionId;
    }
    if (row.type === "user") {
      const content = row.message?.content;
      sessionTitle ??= conversationTitle(content);
      if (
        typeof content === "string" &&
        !/^<(local-command-stdout|local-command-stderr|command-name|command-message|system-reminder|bash-input|bash-stdout|bash-stderr)>/.test(
          content
        )
      ) {
        pendingTurn = true;
      }
      requestStart = stamp(row.timestamp, fallbackTimestamp);
      continue;
    }
    if (
      row.type !== "assistant" ||
      !row.message?.usage ||
      !row.message?.model
    ) {
      continue;
    }
    const { usage } = row.message;
    const tokens: TokenBreakdown = {
      cacheRead: n(usage.cache_read_input_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      reasoning: 0,
    };
    const key = row.message.id
      ? row.requestId
        ? `${row.message.id}:${row.requestId}`
        : `message:${row.message.id}`
      : undefined;
    if (key && seen.has(key)) {
      const old = messages[seen.get(key)!]!;
      old.tokens.input = Math.max(old.tokens.input, tokens.input);
      old.tokens.output = Math.max(old.tokens.output, tokens.output);
      old.tokens.cacheRead = Math.max(old.tokens.cacheRead, tokens.cacheRead);
      old.tokens.cacheWrite = Math.max(
        old.tokens.cacheWrite,
        tokens.cacheWrite
      );
      const end = stamp(row.timestamp, old.timestamp);
      if (end >= old.timestamp) {
        old.durationMs =
          Math.max(old.durationMs ?? 0, end - old.timestamp) || undefined;
      }
      continue;
    }
    const completion = stamp(row.timestamp, fallbackTimestamp);
    const timestamp = requestStart ?? completion;
    const provider = String(
      row.message.providerId ?? row.providerId ?? "anthropic"
    );
    const ws = normalizeWorkspace(workspace);
    const message = makeMessage({
      client: "claude",
      cost: 0,
      dedupKey: key,
      durationMs:
        requestStart !== undefined && completion > requestStart
          ? completion - requestStart
          : undefined,
      isTurnStart: pendingTurn,
      modelId: String(row.message.model),
      providerId: provider,
      sessionId,
      sessionTitle,
      timestamp,
      tokens,
      workspaceKey: ws.key,
      workspaceLabel: ws.label,
    });
    if (key) {
      seen.set(key, messages.length);
    }
    messages.push(message);
    pendingTurn = false;
    requestStart = undefined;
  }
  return messages;
}

interface Totals {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
}
const totals = (u: Json): Totals => ({
  cached: Math.max(n(u.cached_input_tokens), n(u.cache_read_input_tokens)),
  input: n(u.input_tokens),
  output: n(u.output_tokens),
  reasoning: n(u.reasoning_output_tokens),
});
const same = (a: Totals, b: Totals) =>
  a.input === b.input &&
  a.output === b.output &&
  a.cached === b.cached &&
  a.reasoning === b.reasoning;
const toTokens = (t: Totals): TokenBreakdown => {
  const cached = Math.min(t.cached, t.input);
  return {
    cacheRead: cached,
    cacheWrite: 0,
    input: t.input - cached,
    output: t.output,
    reasoning: t.reasoning,
  };
};

/** Port of tokscale-core Codex token_count state machine (standard and headless lanes). */
export function parseCodex(
  contents: string,
  sourcePath: string,
  fallbackTimestamp = Date.now()
): UsageMessage[] {
  const out: UsageMessage[] = [];
  let agent: string | undefined,
    model: string | undefined,
    provider = "openai",
    workspace: string | undefined;
  let sessionId = stem(sourcePath),
    sessionTitle: string | undefined,
    cursor: number | undefined,
    previous: Totals | undefined;
  let pendingTurn = false,
    turnStart: number | undefined;
  for (const line of contents.split(/\r?\n/)) {
    let row: Json;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const p = row.payload ?? {};
    if (row.type === "session_meta") {
      sessionId = String(p.id ?? sessionId);
      provider = String(p.model_provider ?? provider);
      agent = p.source === "exec" ? "headless" : p.agent_nickname;
      workspace = typeof p.cwd === "string" ? p.cwd : workspace;
      continue;
    }
    if (row.type === "turn_context") {
      workspace = typeof p.cwd === "string" ? p.cwd : workspace;
      model = p.model_info?.slug ?? p.model ?? p.model_name ?? model;
      turnStart = stamp(row.timestamp, fallbackTimestamp);
      cursor = turnStart;
      continue;
    }
    if (row.type === "event_msg" && p.type === "user_message") {
      const text = typeof p.message === "string" ? p.message.trimStart() : "";
      sessionTitle ??= conversationTitle(text);
      if (
        text &&
        !/^<(environment_context|system-reminder|user_instructions)>/.test(text)
      ) {
        pendingTurn = true;
      }
      cursor = stamp(row.timestamp, fallbackTimestamp);
      continue;
    }
    if (row.type === "event_msg" && p.type === "token_count" && p.info) {
      model =
        p.model_info?.slug ??
        p.model ??
        p.model_name ??
        p.info.model ??
        p.info.model_name ??
        model;
      const total = p.info.total_token_usage
        ? totals(p.info.total_token_usage)
        : undefined;
      const last = p.info.last_token_usage
        ? totals(p.info.last_token_usage)
        : undefined;
      if (total && previous && same(total, previous)) {
        continue;
      }
      if (
        total &&
        previous &&
        last &&
        (total.input < previous.input ||
          total.output < previous.output ||
          total.cached < previous.cached ||
          total.reasoning < previous.reasoning)
      ) {
        const sum = (x: Totals) => x.input + x.output + x.cached + x.reasoning;
        if (
          sum(total) * 100 >= sum(previous) * 98 ||
          sum(total) + sum(last) * 2 >= sum(previous)
        ) {
          continue;
        }
      }
      let increment: Totals | undefined;
      if (last) {
        increment = last;
      } else if (
        total &&
        previous &&
        total.input >= previous.input &&
        total.output >= previous.output &&
        total.cached >= previous.cached &&
        total.reasoning >= previous.reasoning
      ) {
        increment = {
          cached: total.cached - previous.cached,
          input: total.input - previous.input,
          output: total.output - previous.output,
          reasoning: total.reasoning - previous.reasoning,
        };
      } else if (total && !previous) {
        increment = total;
      }
      if (!increment) {
        if (total) {
          previous = total;
        }
        continue;
      }
      const tokens = toTokens(increment);
      if (
        !tokens.input &&
        !tokens.output &&
        !tokens.cacheRead &&
        !tokens.reasoning
      ) {
        continue;
      }
      previous =
        total ??
        (previous
          ? {
              cached: previous.cached + increment.cached,
              input: previous.input + increment.input,
              output: previous.output + increment.output,
              reasoning: previous.reasoning + increment.reasoning,
            }
          : undefined);
      const parsed = stamp(row.timestamp, fallbackTimestamp);
      const timestamp = cursor ?? parsed;
      out.push(
        makeMessage({
          agent,
          client: "codex",
          cost: 0,
          durationMs: parsed > timestamp ? parsed - timestamp : undefined,
          isTurnStart: pendingTurn,
          modelId: model ?? "unknown",
          providerId: provider,
          sessionId,
          sessionTitle,
          timestamp,
          tokens,
          workspaceKey: normalizeWorkspace(workspace).key,
          workspaceLabel: normalizeWorkspace(workspace).label,
        })
      );
      pendingTurn = false;
      if (
        typeof row.timestamp === "string" &&
        Number.isFinite(Date.parse(row.timestamp)) &&
        (cursor === undefined || parsed > cursor)
      ) {
        cursor = parsed;
      }
      continue;
    }
    // Generic Codex exec/headless usage format.
    const usage =
      row.usage ?? row.data?.usage ?? row.result?.usage ?? row.response?.usage;
    if (usage) {
      model =
        row.model ??
        row.model_name ??
        row.data?.model ??
        row.response?.model ??
        model ??
        "unknown";
      const cached = n(
        usage.cached_input_tokens ??
          usage.cache_read_input_tokens ??
          usage.cached_tokens
      );
      const tokens = zeroTokens();
      tokens.input = Math.max(
        0,
        n(usage.input_tokens ?? usage.prompt_tokens ?? usage.input) - cached
      );
      tokens.output = n(
        usage.output_tokens ?? usage.completion_tokens ?? usage.output
      );
      tokens.cacheRead = cached;
      if (tokens.input || tokens.output || tokens.cacheRead) {
        out.push(
          makeMessage({
            agent,
            client: "codex",
            cost: 0,
            modelId: model!,
            providerId: provider,
            sessionId,
            sessionTitle,
            timestamp: stamp(row.timestamp, fallbackTimestamp),
            tokens,
            workspaceKey: normalizeWorkspace(workspace).key,
            workspaceLabel: normalizeWorkspace(workspace).label,
          })
        );
      }
    }
  }
  return out;
}
