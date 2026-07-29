/* eslint-disable vitest/prefer-importing-vitest-globals */
import { describe, expect, test } from "bun:test";

import { decryptPayload, encryptPayload, isIngestRequest } from "../src/index";

const validPayload = () => ({
  device: { id: "device", name: "Laptop", platform: "darwin" },
  sessions: [
    {
      deviceId: "device",
      messages: [
        {
          client: "codex",
          cost: 0.01,
          costSource: "estimated",
          date: "2026-01-01",
          isTurnStart: true,
          messageCount: 1,
          modelId: "gpt-5",
          providerId: "openai",
          sessionId: "session",
          timestamp: 1_767_225_600_000,
          tokens: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 10,
            output: 2,
            reasoning: 0,
          },
        },
      ],
      sessionId: "session",
      sourceMtimeMs: 1,
      sourcePath: "/tmp/session.jsonl",
      sourceSize: 100,
    },
  ],
  sourceUpdates: [{ mode: "replace", sourcePath: "/tmp/session.jsonl" }],
});

describe("ingestion security", () => {
  test("round-trips encrypted payloads and rejects the wrong key", async () => {
    const value = validPayload();
    const encrypted = await encryptPayload(value, "correct-key");
    expect(await decryptPayload(encrypted, "correct-key")).toEqual(value);
    expect(decryptPayload(encrypted, "wrong-key")).rejects.toBeInstanceOf(
      Error
    );
  });

  test("validates complete ingestion payloads", () => {
    expect(isIngestRequest(validPayload())).toBe(true);

    const invalidCost = validPayload();
    const [invalidCostSession] = invalidCost.sessions;
    const [invalidCostMessage] = invalidCostSession?.messages ?? [];
    if (invalidCostMessage) {
      invalidCostMessage.cost = Number.POSITIVE_INFINITY;
    }
    expect(isIngestRequest(invalidCost)).toBe(false);

    const mismatchedSession = validPayload();
    const [session] = mismatchedSession.sessions;
    const [mismatchedMessage] = session?.messages ?? [];
    if (mismatchedMessage) {
      mismatchedMessage.sessionId = "another";
    }
    expect(isIngestRequest(mismatchedSession)).toBe(false);

    const invalidUpdate = validPayload();
    const [sourceUpdate] = invalidUpdate.sourceUpdates;
    if (sourceUpdate) {
      sourceUpdate.mode = "unsafe";
    }
    expect(isIngestRequest(invalidUpdate)).toBe(false);
  });
});
