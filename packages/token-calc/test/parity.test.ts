/* eslint-disable vitest/prefer-importing-vitest-globals */
import { describe, expect, test } from "bun:test";

import {
  parseCodex,
  parseClaude,
  canonicalModelId,
  calculateCost,
  summarize,
} from "../src";

const fixture = await Bun.file(
  new URL("fixtures/codex_duration_timing.jsonl", import.meta.url)
).text();

describe("tokscale-core parity", () => {
  test("codex_duration_timing upstream fixture matches Rust parser", () => {
    const messages = parseCodex(
      fixture,
      "codex_duration_timing.jsonl",
      Date.parse("2040-01-01T00:00:00Z")
    );
    // Oracle: tokscale-core sessions::codex::test_token_count_durations_are_non_overlapping.
    expect(messages.map((m) => m.durationMs)).toEqual([1000, 4000, 2000]);
    expect(messages.map((m) => m.tokens)).toEqual([
      { cacheRead: 20, cacheWrite: 0, input: 80, output: 10, reasoning: 5 },
      { cacheRead: 5, cacheWrite: 0, input: 15, output: 4, reasoning: 2 },
      { cacheRead: 5, cacheWrite: 0, input: 15, output: 6, reasoning: 3 },
    ]);
  });

  test("Codex headless fixture matches tokscale-core", () => {
    const result = parseCodex(
      '{"type":"turn.completed","model":"gpt-4o-mini","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30}}',
      "headless.jsonl",
      1000
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.tokens).toEqual({
      cacheRead: 20,
      cacheWrite: 0,
      input: 100,
      output: 30,
      reasoning: 0,
    });
  });

  test("Claude streaming duplicates use per-field maxima", () => {
    const data = [
      {
        message: { content: "hello" },
        timestamp: "2026-01-01T00:00:00Z",
        type: "user",
      },
      {
        message: {
          id: "m",
          model: "claude-sonnet-4-5",
          usage: {
            cache_read_input_tokens: 3,
            input_tokens: 10,
            output_tokens: 2,
          },
        },
        requestId: "r",
        timestamp: "2026-01-01T00:00:01Z",
        type: "assistant",
      },
      {
        message: {
          id: "m",
          model: "claude-sonnet-4-5",
          usage: {
            cache_read_input_tokens: 3,
            input_tokens: 10,
            output_tokens: 8,
          },
        },
        requestId: "r",
        timestamp: "2026-01-01T00:00:02Z",
        type: "assistant",
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    const result = parseClaude(data, "session.jsonl");
    expect(result).toHaveLength(1);
    expect(result[0]?.tokens.output).toBe(8);
    expect(result[0]?.durationMs).toBe(2000);
    expect(result[0]?.isTurnStart).toBe(true);
  });

  test("does not include models with no token usage", () => {
    const summary = summarize([
      {
        client: "copilot",
        cost: 0,
        costSource: "unknown",
        date: "2026-01-01",
        isTurnStart: false,
        messageCount: 1,
        modelId: "unused-model",
        providerId: "github-copilot",
        sessionId: "session",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
        tokens: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          reasoning: 0,
        },
      },
      {
        client: "copilot",
        cost: 0,
        costSource: "unknown",
        date: "2026-01-01",
        isTurnStart: false,
        messageCount: 1,
        modelId: "used-model",
        providerId: "github-copilot",
        sessionId: "session",
        timestamp: Date.parse("2026-01-01T00:00:01Z"),
        tokens: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 1,
          output: 0,
          reasoning: 0,
        },
      },
    ]);

    expect(summary.models).toEqual([
      { cost: 0, name: "used-model", tokens: 1 },
    ]);
  });

  test("does not attribute Hermes usage to legacy unknown projects", () => {
    const summary = summarize([
      {
        agent: "Hermes Agent",
        client: "hermes",
        cost: 0.01,
        costSource: "providerReported",
        date: "2026-01-01",
        isTurnStart: false,
        messageCount: 1,
        modelId: "claude-sonnet-4-5",
        providerId: "anthropic",
        sessionId: "hermes-session",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
        tokens: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 10,
          output: 5,
          reasoning: 0,
        },
        workspaceLabel: "Unknown project",
      },
    ]);

    expect(summary.projects).toEqual([]);
    expect(summary.totals.tokens).toBe(15);
    expect(summary.agents[0]?.tokens).toBe(15);
  });

  test("does not invent a project when workspace is missing", () => {
    const summary = summarize([
      {
        client: "cursor",
        cost: 0.2,
        costSource: "providerReported",
        date: "2026-01-01",
        isTurnStart: false,
        messageCount: 1,
        modelId: "grok-4.6",
        providerId: "xai",
        sessionId: "cursor-active-2026-01-01",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
        tokens: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 10,
          output: 5,
          reasoning: 0,
        },
      },
    ]);
    expect(summary.projects).toEqual([]);
    expect(summary.totals.tokens).toBe(15);
  });

  test("model canonicalization and million-token pricing mirror tokscale", () => {
    expect(canonicalModelId("Anthropic/Claude-4-5-Sonnet")).toBe(
      "claude-sonnet-4-5"
    );
    expect(canonicalModelId("CLAUDE-3.5-SONNET-20241022")).toBe(
      "claude-3-5-sonnet"
    );
    expect(canonicalModelId("cursor-grok-4.6-medium")).toBe("grok-4.6");
    expect(canonicalModelId("claude-opus-4-8-thinking-high")).toBe(
      "claude-opus-4-8"
    );
    expect(canonicalModelId("o4-mini-high")).toBe("o4-mini-high");
    expect(canonicalModelId("cursor-small")).toBe("cursor-small");
    expect(
      calculateCost(
        {
          cacheRead: 0,
          cacheWrite: 0,
          input: 1_000_000,
          output: 10_000,
          reasoning: 0,
        },
        { input: 3, output: 15 }
      )
    ).toBe(3.15);
  });
});
