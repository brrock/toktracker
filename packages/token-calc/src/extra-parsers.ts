/* eslint-disable complexity, func-style, no-nested-ternary, require-unicode-regexp, sort-vars, typescript/no-explicit-any, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */
// OpenCode schema compatibility requires probing multiple dynamic JSON/SQLite shapes.
import { Database } from "bun:sqlite";

import type { UsageMessage } from "@toktracker/shared";

import {
  canonicalProvider,
  inferProvider,
  normalizeAgent,
  normalizeWorkspace,
} from "./identity";
import { makeMessage } from "./model";

// Dynamic third-party telemetry changes shape across producer versions.
type Json = Record<string, any>;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
const fileStem = (path: string) =>
  path
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "") ?? "unknown";
const parseLines = (text: string): Json[] =>
  text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const timestamp = (value: unknown, fallback = 0) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : typeof value === "number"
      ? value
      : fallback;
const knownProviders = new Set([
  "anthropic",
  "openai",
  "azure",
  "google",
  "github-copilot",
  "xai",
  "mistral",
  "deepseek",
  "alibaba",
]);
const hermesProvider = (billing: unknown, model: string) => {
  const supplied =
    typeof billing === "string" ? canonicalProvider(billing) : "";
  return knownProviders.has(supplied)
    ? supplied
    : (inferProvider(model) ?? "hermes");
};

function conversationTitle(content: unknown): string | undefined {
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
}

function piAgent(name: string): string | undefined {
  if (!name.startsWith("subagent-")) {
    return;
  }
  let value = name.slice(9);
  value = value
    .replace(/-[0-9a-f]{8}(?:-\d+)?$/i, "")
    .replace(
      /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i,
      ""
    );
  return value || undefined;
}
export function parsePi(
  contents: string,
  sourcePath: string,
  fallback = Date.now()
): UsageMessage[] {
  const lines = parseLines(contents);
  let agent: string | undefined,
    header: Json | undefined,
    sessionTitle: string | undefined,
    started = false;
  const out: UsageMessage[] = [];
  for (const row of lines) {
    if (!started) {
      if (row.type === "title") {
        if (typeof row.title === "string" && row.title.trim()) {
          sessionTitle = row.title.trim();
        }
        continue;
      }
      if (row.type !== "session") {
        return [];
      }
      header = row;
      started = true;
      continue;
    }
    if (row.type === "session_info" && typeof row.name === "string") {
      const name = row.name.trim();
      if (name) {
        // Pi writes Ctrl+R / /name changes as session_info entries, which can
        // occur after usage entries. Keep the final name for the whole session.
        sessionTitle = name;
        agent = piAgent(name) ?? agent;
      }
      continue;
    }
    const m = row.message;
    if (row.type === "message" && m?.role === "user" && !sessionTitle) {
      sessionTitle = conversationTitle(m.content);
    }
    const u = m?.usage;
    if (row.type !== "message" || m?.role !== "assistant" || !u || !m.model) {
      continue;
    }
    const ws = normalizeWorkspace(header?.cwd);
    out.push(
      makeMessage({
        agent,
        client: "pi",
        cost: 0,
        modelId: m.model,
        providerId: m.provider || inferProvider(m.model) || "pi",
        sessionId: header?.id || "unknown",
        sessionTitle,
        timestamp: timestamp(row.timestamp, fallback),
        tokens: {
          cacheRead: num(u.cacheRead),
          cacheWrite: num(u.cacheWrite),
          input: num(u.input),
          output: num(u.output),
          reasoning: 0,
        },
        workspaceKey: ws.key,
        workspaceLabel: ws.label,
      })
    );
  }
  return out.map((message) => ({ ...message, sessionTitle }));
}

function opencodeMessage(
  msg: Json,
  sessionId: string,
  dedup: string,
  rowWorkspace?: string,
  title?: string
): UsageMessage | undefined {
  if ((msg.role !== undefined && msg.role !== "assistant") || !msg.tokens) {
    return;
  }
  const model = msg.modelID ?? msg.model?.id;
  if (!model) {
    return;
  }
  const u = msg.tokens,
    created = Number(msg.time?.created);
  if (!Number.isFinite(created)) {
    return;
  }
  const ws = normalizeWorkspace(rowWorkspace ?? msg.path?.root);
  const cost =
    typeof msg.cost === "number" && Number.isFinite(msg.cost) && msg.cost >= 0
      ? msg.cost
      : 0;
  return makeMessage({
    agent:
      typeof (msg.mode ?? msg.agent) === "string"
        ? normalizeAgent(msg.mode ?? msg.agent)
        : undefined,
    client: "opencode",
    cost,
    costSource: cost > 0 ? "providerReported" : "unknown",
    dedupKey: msg.id ?? dedup,
    durationMs:
      Number.isFinite(msg.time?.completed) && msg.time.completed > created
        ? Math.trunc(msg.time.completed - created)
        : undefined,
    modelId: model,
    providerId: canonicalProvider(
      msg.providerID ?? msg.model?.providerID ?? "unknown"
    ),
    sessionId: msg.sessionID ?? sessionId,
    sessionTitle: title?.trim() || undefined,
    timestamp: created,
    tokens: {
      cacheRead: num(u.cache?.read),
      cacheWrite: num(u.cache?.write),
      input: num(u.input),
      output: num(u.output),
      reasoning: num(u.reasoning),
    },
    workspaceKey: ws.key,
    workspaceLabel: ws.label,
  });
}
export function parseOpenCodeJson(
  contents: string,
  sourcePath: string
): UsageMessage[] {
  try {
    const msg = JSON.parse(contents);
    if (msg.role !== "assistant") {
      return [];
    }
    const parsed = opencodeMessage(
      msg,
      msg.sessionID ?? "unknown",
      fileStem(sourcePath)
    );
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

export function parseOpenCodeSqlite(path: string): UsageMessage[] {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, strict: true });
  } catch {
    return [];
  }
  const out: UsageMessage[] = [];
  const fingerprints = new Map<string, number>();
  const queries = [
    `SELECT sm.id id,sm.session_id session_id,sm.data data,NULLIF(s.directory,'') workspace, s.title title FROM session_message sm LEFT JOIN session s ON s.id=sm.session_id WHERE sm.type='assistant'`,
    `SELECT m.id id,m.session_id session_id,m.data data,NULLIF(s.directory,'') workspace,s.title title FROM message m LEFT JOIN session s ON s.id=m.session_id WHERE json_extract(m.data,'$.role')='assistant'`,
    `SELECT m.id id,m.session_id session_id,m.data data,NULL workspace,NULL title FROM message m WHERE json_extract(m.data,'$.role')='assistant'`,
  ];
  for (const query of queries) {
    let rows: Json[];
    try {
      // SAFETY: the parser checks the producer schema branch before reading this dynamic record.
      rows = db.query(query).all() as Json[];
    } catch {
      continue;
    }
    for (const row of rows) {
      let data: Json;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      const parsed = opencodeMessage(
        data,
        row.session_id,
        row.id,
        row.workspace,
        row.title
      );
      if (!parsed) {
        continue;
      }
      const fp = JSON.stringify([
        parsed.timestamp,
        parsed.durationMs,
        parsed.modelId,
        parsed.providerId,
        parsed.tokens,
        parsed.cost,
        parsed.agent,
        data.id ?? null,
      ]);
      if (fingerprints.has(fp)) {
        continue;
      }
      fingerprints.set(fp, out.length);
      out.push(parsed);
    }
  }
  db.close();
  return out;
}

export function parseHermesSqlite(path: string): UsageMessage[] {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, strict: true });
  } catch {
    return [];
  }
  let rows: Json[];
  const whereClause = `model IS NOT NULL AND TRIM(model)!='' AND (COALESCE(input_tokens,0)>0 OR COALESCE(output_tokens,0)>0 OR COALESCE(cache_read_tokens,0)>0 OR COALESCE(cache_write_tokens,0)>0 OR COALESCE(reasoning_tokens,0)>0 OR COALESCE(actual_cost_usd,estimated_cost_usd,0)>0)`;
  try {
    // SAFETY: the parser checks the producer schema branch before reading this dynamic record.
    rows = db
      .query(
        `SELECT id,title,model,billing_provider,started_at,message_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_cost_usd,actual_cost_usd FROM sessions WHERE ${whereClause}`
      )
      // SAFETY: the parser checks the producer schema branch before reading this dynamic record.
      .all() as Json[];
  } catch {
    try {
      // SAFETY: the parser checks the producer schema branch before reading this dynamic record.
      rows = db
        .query(
          `SELECT id,NULL title,model,billing_provider,started_at,message_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_cost_usd,actual_cost_usd FROM sessions WHERE ${whereClause}`
        )
        // SAFETY: the parser checks the producer schema branch before reading this dynamic record.
        .all() as Json[];
    } catch {
      db.close();
      return [];
    }
  }
  db.close();
  return rows.map((r) => {
    const cost = Math.max(
      0,
      Number(r.actual_cost_usd ?? r.estimated_cost_usd ?? 0)
    );
    return makeMessage({
      agent: "Hermes Agent",
      client: "hermes",
      cost,
      costSource: cost > 0 ? "providerReported" : "unknown",
      dedupKey: r.id,
      messageCount: num(r.message_count),
      modelId: r.model,
      providerId: hermesProvider(r.billing_provider, r.model),
      sessionId: r.id,
      sessionTitle:
        typeof r.title === "string" && r.title.trim()
          ? r.title.trim()
          : undefined,
      timestamp:
        Number(r.started_at) > 1e12
          ? Math.trunc(r.started_at)
          : Math.trunc(Number(r.started_at) * 1000),
      tokens: {
        cacheRead: num(r.cache_read_tokens),
        cacheWrite: num(r.cache_write_tokens),
        input: num(r.input_tokens),
        output: num(r.output_tokens),
        reasoning: num(r.reasoning_tokens),
      },
    });
  });
}
