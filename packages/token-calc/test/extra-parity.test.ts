import { Database } from "bun:sqlite";
/* eslint-disable sort-vars, unicorn/import-style, unicorn/numeric-separators-style, vitest/prefer-importing-vitest-globals */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseCopilotDesktopSqlite,
  parseCopilotOtel,
  parseCopilotVsCode,
  parseHermesSqlite,
  parseOpenCodeJson,
  parseOpenCodeSqlite,
  parsePi,
} from "../src";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { force: true, recursive: true }))
  );
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "toktracker-"));
  dirs.push(d);
  return d;
};

describe("additional tokscale client parity", () => {
  test("Pi usage, workspace and missing-provider inference", () => {
    const data = `{"type":"title","title":"test"}\n{"type":"session","id":"pi_ses_001","cwd":"/Users/a/project"}\n{"type":"message","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","model":"gpt-5","usage":{"input":100,"output":50,"cacheRead":10,"cacheWrite":5}}}`;
    const [m] = parsePi(data, "x.jsonl");
    expect(m?.sessionId).toBe("pi_ses_001");
    expect(m?.sessionTitle).toBe("test");
    expect(m?.providerId).toBe("openai");
    expect(m?.workspaceLabel).toBe("project");
    expect(m?.tokens).toEqual({
      cacheRead: 10,
      cacheWrite: 5,
      input: 100,
      output: 50,
      reasoning: 0,
    });
  });
  test("Pi session rename overrides the inferred title", () => {
    const data = `{"type":"session","id":"s","cwd":"/tmp"}\n{"type":"message","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"Original title"}}\n{"type":"message","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","model":"gpt-5","provider":"openai","usage":{"input":1,"output":1}}}\n{"type":"session_info","name":"New storage"}`;
    expect(parsePi(data, "x")[0]?.sessionTitle).toBe("New storage");
  });
  test("Pi subagent extraction matches upstream", () => {
    const data = `{"type":"session","id":"s","cwd":"/tmp"}\n{"type":"session_info","name":"subagent-go-reviewer-e2e7405c-cb84-4f0a-a6da-9d987494d130-1"}\n{"type":"message","message":{"role":"assistant","model":"gpt-5","provider":"openai","usage":{"input":1,"output":1}}}`;
    expect(parsePi(data, "x")[0]?.agent).toBe("go-reviewer");
  });
  test("OpenCode legacy JSON authoritative cost and duration", () => {
    const [m] = parseOpenCodeJson(
      JSON.stringify({
        cost: 0.25,
        id: "m1",
        mode: "sisyphus",
        modelID: "claude-sonnet-4-5",
        path: { root: "/a/repo" },
        providerID: "anthropic",
        role: "assistant",
        sessionID: "s1",
        time: { completed: 1250, created: 1000 },
        tokens: {
          cache: { read: 3, write: 4 },
          input: 10,
          output: 2,
          reasoning: 1,
        },
      }),
      "m1.json"
    );
    expect(m?.costSource).toBe("providerReported");
    expect(m?.durationMs).toBe(250);
    expect(m?.agent).toBe("Sisyphus");
    expect(m?.workspaceLabel).toBe("repo");
  });
  test("OpenCode v1 SQLite", async () => {
    const d = await temp(),
      path = join(d, "opencode.db"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE session(id TEXT,directory TEXT,title TEXT);CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)"
    );
    db.query("INSERT INTO session VALUES(?,?,?)").run(
      "s1",
      "/a/repo",
      "Ship it"
    );
    db.query("INSERT INTO message VALUES(?,?,?)").run(
      "row1",
      "s1",
      JSON.stringify({
        id: "m1",
        modelID: "gpt-5",
        providerID: "openai",
        role: "assistant",
        time: { created: 5000 },
        tokens: { cache: { read: 2, write: 0 }, input: 20, output: 5 },
      })
    );
    db.close();
    const [m] = parseOpenCodeSqlite(path);
    expect(m?.sessionTitle).toBe("Ship it");
    expect(m?.tokens.input).toBe(20);
  });
  test("Hermes aggregate SQLite exact row mapping", async () => {
    const d = await temp(),
      path = join(d, "state.db"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE sessions(id TEXT,model TEXT,billing_provider TEXT,started_at REAL,message_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,estimated_cost_usd REAL,actual_cost_usd REAL)"
    );
    db.query("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "h1",
      "claude-sonnet-4-5",
      "anthropic",
      1_767_225_600,
      4,
      100,
      20,
      30,
      5,
      2,
      0.2,
      0.15
    );
    db.close();
    const [m] = parseHermesSqlite(path);
    expect(m?.agent).toBe("Hermes Agent");
    expect(m?.cost).toBe(0.15);
    expect(m?.messageCount).toBe(4);
    expect(m?.timestamp).toBe(1_767_225_600_000);
  });
  test("Hermes unknown billing provider falls back to model inference", async () => {
    const d = await temp(),
      path = join(d, "state.db"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE sessions(id TEXT,model TEXT,billing_provider TEXT,started_at REAL,message_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,estimated_cost_usd REAL,actual_cost_usd REAL)"
    );
    db.query("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "h2",
      "gpt-5",
      "custom-router",
      1_767_225_600,
      1,
      10,
      1,
      0,
      0,
      0,
      0,
      null
    );
    db.close();
    expect(parseHermesSqlite(path)[0]?.providerId).toBe("openai");
  });
  test("Copilot VS Code kind 0/2 and reasoning", () => {
    const data = JSON.stringify({
      k: ["requests"],
      kind: 2,
      v: [
        {
          completionTokens: 200,
          modelId: "copilot/auto",
          promptTokens: 5000,
          result: {
            metadata: {
              resolvedModel: "gpt-5.3-codex",
              toolCallRounds: [
                { thinking: { tokens: 88 } },
                { thinking: { tokens: 12 } },
              ],
            },
          },
          timestamp: 1783918310000,
        },
      ],
    });
    const [m] = parseCopilotVsCode(data, "session-1.jsonl");
    expect(m?.modelId).toBe("gpt-5.3-codex");
    expect(m?.tokens.reasoning).toBe(100);
    expect(m?.dedupKey).toBe("copilot-vscode:session-1:1783918310000");
  });
  test("Copilot Desktop subtracts cache from inclusive input", async () => {
    const d = await temp(),
      path = join(d, "data.db"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE sessions(id TEXT,model TEXT,total_input_tokens INTEGER,total_output_tokens INTEGER,total_cached_tokens INTEGER,total_reasoning_tokens INTEGER,created_at TEXT)"
    );
    db.query("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(
      "s1",
      "gpt-5.1-codex",
      100,
      50,
      25,
      10,
      "2026-07-01T12:34:56Z"
    );
    db.close();
    const [m] = parseCopilotDesktopSqlite(path);
    expect(m?.tokens).toEqual({
      cacheRead: 25,
      cacheWrite: 0,
      input: 75,
      output: 50,
      reasoning: 10,
    });
    expect(m?.timestamp).toBe(1_782_909_296_000);
  });
  test("Copilot OTEL prioritizes chat and normalizes cache", () => {
    const data = [
      {
        attributes: {
          "gen_ai.conversation.id": "s1",
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "gpt-5",
          "gen_ai.usage.cache_read.input_tokens": 25,
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 20,
        },
        endTime: [1_767_225_601, 0],
        name: "chat gpt",
        spanId: "1",
        startTime: [1_767_225_600, 0],
        traceId: "abc",
        type: "span",
      },
      {
        attributes: {
          "event.name": "gen_ai.client.inference.operation.details",
          "gen_ai.response.model": "gpt-5",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 20,
        },
        body: "GenAI inference: done",
        traceId: "abc",
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    const messages = parseCopilotOtel(data, "otel.jsonl");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.tokens.input).toBe(75);
    expect(messages[0]?.durationMs).toBe(1000);
  });
});
