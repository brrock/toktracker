import { Database } from "bun:sqlite";
/* eslint-disable unicorn/import-style, unicorn/consistent-function-scoping, require-await, vitest/prefer-importing-vitest-globals */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CursorFetch } from "../src";
import {
  deriveAccountId,
  listCursorUsageCsvFiles,
  normalizeCursorSessionToken,
  parseCursorCsv,
  parseOpenClaw,
  parseOpenClawIndex,
  readDesktopCursorSessions,
  resolveCursorPaths,
  sessionTokenFromAccessToken,
  syncCursorUsageCaches,
  upsertCursorAccount,
} from "../src";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "toktracker-cursor-"));
  dirs.push(dir);
  return dir;
};

const jwtForUser = (userId: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({ sub: `auth0|${userId}` })
  ).toString("base64url");
  return `${header}.${payload}.sig`;
};

describe("Cursor usage CSV parser", () => {
  test("parses v1 and v2 exports with per-account sessions", () => {
    const v1 = `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you
2025-02-01,gpt-4o,10,5,0,15,30,$0.10,$0.10`;
    const [old] = parseCursorCsv(v1, "/tmp/usage.csv");
    expect(old?.client).toBe("cursor");
    expect(old?.providerId).toBe("openai");
    expect(old?.tokens).toEqual({
      cacheRead: 0,
      cacheWrite: 10,
      input: 5,
      output: 15,
      reasoning: 0,
    });
    expect(old?.cost).toBe(0.1);
    expect(old?.costSource).toBe("providerReported");
    expect(old?.sessionId).toBe("cursor-active-2025-02-01");

    const v2 = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2025-11-13T18:36:05.846Z","Included","auto","No","28342","775","105891","21282","156290","0.19"`;
    const [next] = parseCursorCsv(v2, "/tmp/usage.csv");
    expect(next?.modelId).toBe("auto");
    expect(next?.providerId).toBe("cursor");
    expect(next?.workspaceLabel).toBeUndefined();
    expect(next?.tokens.cacheRead).toBe(105_891);
    expect(next?.cost).toBe(0.19);
  });

  test("keeps Cloud Agent ids on the session title, not as a project", () => {
    const v3 = `Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-04-09T20:01:10.528Z","bc-a","cc-a","Included","composer-2","Yes","0","343446","29045760","915201","30304407","Included"
"2026-04-09T18:02:13.576Z","bc-b","cc-b","On-Demand","composer-2","Yes","0","43478","420864","7957","472299","0.11"`;
    const rows = parseCursorCsv(v3, "/tmp/usage.work.csv");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.cost).toBe(0);
    expect(rows[0]?.costSource).toBe("unknown");
    expect(rows[0]?.sessionId).toBe("cursor-work-2026-04-09T20:01:10.528Z");
    expect(rows[0]?.workspaceLabel).toBeUndefined();
    expect(rows[0]?.sessionTitle).toBe("Cloud agent bc-a");
    expect(rows[1]?.cost).toBe(0.11);
    expect(rows[1]?.costSource).toBe("providerReported");
    expect(rows[1]?.workspaceLabel).toBeUndefined();
    expect(rows[1]?.sessionTitle).toBe("Cloud agent bc-b");
  });

  test("splits Cursor provider prefixes and reasoning depth from model ids", () => {
    const csv = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-08-24T12:00:00.000Z","On-Demand","cursor-grok-4.6-medium","No","10","5","20","3","38","0.20"
"2026-08-24T12:01:00.000Z","On-Demand","claude-opus-4-8-thinking-high","No","10","5","20","3","38","0.30"`;
    const rows = parseCursorCsv(csv, "usage.csv");
    expect(rows[0]?.modelId).toBe("grok-4.6");
    expect(rows[0]?.providerId).toBe("xai");
    expect(rows[1]?.modelId).toBe("claude-opus-4-8");
    expect(rows[1]?.providerId).toBe("anthropic");
  });

  test("treats explicit zero cost as provider-reported", () => {
    const csv = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-08-18T12:00:00.000Z","On-Demand","gpt-5","No","10","5","20","3","38","$0.00"`;
    const [row] = parseCursorCsv(csv, "usage.csv");
    expect(row?.cost).toBe(0);
    expect(row?.costSource).toBe("providerReported");
  });
});

describe("Cursor desktop auth and multi-account sync", () => {
  test("builds a session token from a desktop access-token JWT", () => {
    const access = jwtForUser("user_abc");
    expect(sessionTokenFromAccessToken(access)).toBe(`user_abc%3A%3A${access}`);
    expect(normalizeCursorSessionToken(`user_abc::${access}`)).toBe(
      `user_abc%3A%3A${access}`
    );
    expect(deriveAccountId(`user_abc%3A%3A${access}`)).toBe("user_abc");
  });

  test("imports the signed-in Cursor desktop account from state.vscdb", async () => {
    const home = await temp();
    const dir = join(home, ".config", "Cursor", "User", "globalStorage");
    await mkdir(dir, { recursive: true });
    const dbPath = join(dir, "state.vscdb");
    const access = jwtForUser("user_desktop");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [
      "cursorAuth/accessToken",
      access,
    ]);
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [
      "cursorAuth/cachedEmail",
      "work@example.com",
    ]);
    db.close();
    const sessions = readDesktopCursorSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionToken).toBe(`user_desktop%3A%3A${access}`);
    expect(sessions[0]?.email).toBe("work@example.com");
  });

  test("syncs usage CSV for every saved Cursor account", async () => {
    const root = await temp();
    const paths = resolveCursorPaths(join(root, "data"), join(root, "home"));
    const personal = jwtForUser("user_personal");
    const work = jwtForUser("user_work");
    await upsertCursorAccount(
      paths,
      `user_personal%3A%3A${personal}`,
      "personal"
    );
    await upsertCursorAccount(paths, `user_work%3A%3A${work}`, "work");
    const fetchImpl: CursorFetch = async (_url, init) => {
      const cookie = new Headers(init?.headers).get("Cookie") ?? "";
      const csv = cookie.includes("user_work")
        ? `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-08-18T12:00:00.000Z","On-Demand","gpt-5","No","1","2","3","4","10","0.02"`
        : `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-08-18T11:00:00.000Z","On-Demand","claude-sonnet-4","No","5","6","7","8","26","0.04"`;
      return new Response(csv, { status: 200 });
    };
    const result = await syncCursorUsageCaches(paths, {
      fetchImpl,
      force: true,
    });
    expect(result.synced).toBe(true);
    expect(result.rows).toBe(2);
    const files = await listCursorUsageCsvFiles(paths);
    expect(files.some((path) => path.endsWith("usage.csv"))).toBe(true);
    expect(files.some((path) => path.includes("usage.user_personal.csv"))).toBe(
      true
    );
  });
});

describe("OpenClaw transcript parser", () => {
  test("uses model_change, snapshots, and embedded model metadata", () => {
    const contents = `{"type":"model_change","provider":"openai-codex","modelId":"gpt-5.2"}
{"type":"message","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":200,"cost":{"total":0.05}},"timestamp":1700000000000}}
{"type":"custom","customType":"model-snapshot","data":{"provider":"anthropic","modelId":"claude-opus-4-6"}}
{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":1,"cacheWrite":2},"timestamp":1700000001000}}
{"type":"message","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-6","usage":{"input":3,"output":4},"timestamp":1700000002000}}`;
    const messages = parseOpenClaw(contents, "/tmp/my-session-123.jsonl");
    expect(messages).toHaveLength(3);
    expect(messages[0]?.sessionId).toBe("my-session-123");
    expect(messages[0]?.modelId).toBe("gpt-5.2");
    expect(messages[0]?.providerId).toBe("openai-codex");
    expect(messages[0]?.tokens.cacheRead).toBe(200);
    expect(messages[0]?.cost).toBe(0.05);
    expect(messages[1]?.modelId).toBe("claude-opus-4-6");
    expect(messages[2]?.modelId).toBe("claude-sonnet-4-6");
  });

  test("derives archived and reset session ids from the filename", () => {
    const contents = `{"type":"model_change","provider":"anthropic","modelId":"claude-opus-4-6"}
{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":5},"timestamp":1700000000000}}`;
    expect(
      parseOpenClaw(
        contents,
        "/tmp/my-session-123.jsonl.deleted.1700000000000"
      )[0]?.sessionId
    ).toBe("my-session-123");
    expect(
      parseOpenClaw(
        contents,
        "/tmp/my-session-123.jsonl.reset.2026-03-20T06-34-44.520Z"
      )[0]?.sessionId
    ).toBe("my-session-123");
  });

  test("parses sessions.json with the missing sessionFile fallback", async () => {
    const dir = await temp();
    const session = `{"type":"model_change","provider":"anthropic","modelId":"claude-3.5-sonnet"}
{"type":"message","message":{"role":"assistant","usage":{"input":100,"output":50},"timestamp":1700000000000}}`;
    await Bun.write(join(dir, "fallback-123.jsonl"), session);
    const index = `{
      "agent:main:main": { "sessionId": "fallback-123" }
    }`;
    const loaded = parseOpenClawIndex(
      index,
      join(dir, "sessions.json"),
      (path) => readFileSync(path, "utf-8")
    );
    expect(loaded[0]?.sessionId).toBe("fallback-123");
    expect(loaded[0]?.modelId).toBe("claude-3.5-sonnet");
  });
});
