/* eslint-disable vitest/prefer-importing-vitest-globals */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IngestRequest, UsageMessage } from "@toktracker/shared";

import { Store } from "../src/store";

const temporaryPaths: string[] = [];
const createStore = async (): Promise<{ dbPath: string; store: Store }> => {
  const directory = await mkdtemp(path.join(tmpdir(), "toktracker-test-"));
  temporaryPaths.push(directory);
  const dbPath = path.join(directory, "gateway.db");
  return { dbPath, store: new Store(dbPath) };
};

const message = (
  sessionId: string,
  timestamp = 1_700_000_000_000
): UsageMessage => ({
  client: "codex",
  cost: 0.01,
  costSource: "estimated",
  date: "2023-11-14",
  isTurnStart: true,
  messageCount: 1,
  modelId: "gpt-5",
  providerId: "openai",
  sessionId,
  timestamp,
  tokens: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, reasoning: 0 },
});

const payload = (
  deviceId: string,
  sourcePath: string,
  sessionId: string,
  timestamp?: number
): IngestRequest => ({
  device: { id: deviceId, name: deviceId, platform: "test" },
  sessions: [
    {
      deviceId,
      messages: [message(sessionId, timestamp)],
      sessionId,
      sourceMtimeMs: 1,
      sourcePath,
      sourceSize: 100,
    },
  ],
});

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("Store", () => {
  test("keeps identical source session IDs separate across devices", async () => {
    const { store } = await createStore();
    store.ingest(
      payload("device-a", "/sessions/shared.jsonl", "shared-session")
    );
    store.ingest(
      payload("device-b", "/sessions/shared.jsonl", "shared-session")
    );

    const sessions = store.sessions("shared-session", [], [], 20);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
    expect(sessions.map((session) => session.deviceId).toSorted()).toEqual([
      "device-a",
      "device-b",
    ]);
    expect(store.summary([], "all").totals.sessions).toBe(2);
    const deviceASession = sessions.find(
      (session) => session.deviceId === "device-a"
    );
    expect(store.session(deviceASession?.id ?? "")?.deviceId).toBe("device-a");
    store.close();
  });

  test("applies replacement and patch updates transactionally", async () => {
    const { store } = await createStore();
    store.ingest(payload("device", "/source.db", "one"));
    store.ingest({
      ...payload("device", "/source.db", "two"),
      sourceUpdates: [
        { mode: "patch", removedSessionIds: ["one"], sourcePath: "/source.db" },
      ],
    });
    expect(
      store.sessions("", [], [], 20).map((session) => session.sessionId)
    ).toEqual(["two"]);

    store.ingest(payload("device", "/source.db", "three"));
    expect(
      store.sessions("", [], [], 20).map((session) => session.sessionId)
    ).toEqual(["three"]);
    store.close();
  });

  test("migrates the original two-column session primary key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toktracker-test-"));
    temporaryPaths.push(directory);
    const dbPath = path.join(directory, "gateway.db");
    const legacy = new Database(dbPath);
    legacy.exec(
      "CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, last_seen INTEGER NOT NULL); CREATE TABLE sessions (device_id TEXT NOT NULL, source_path TEXT NOT NULL, source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL, session_id TEXT NOT NULL, project TEXT, messages_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(device_id, source_path));"
    );
    legacy.close();

    const migrated = new Store(dbPath);
    migrated.ingest(payload("device", "/source.db", "one"));
    migrated.ingest({
      ...payload("device", "/source.db", "two"),
      sourceUpdates: [{ mode: "patch", sourcePath: "/source.db" }],
    });
    expect(migrated.sessions("", [], [], 20)).toHaveLength(2);
    migrated.close();
  });
});
