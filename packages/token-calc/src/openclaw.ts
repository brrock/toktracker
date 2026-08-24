/* eslint-disable complexity, func-style, prefer-destructuring, require-unicode-regexp, typescript/no-explicit-any, unicorn/import-style, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion */
// OpenClaw transcripts change shape across producer versions.
import { dirname, isAbsolute, join } from "node:path";

import type { UsageMessage } from "@toktracker/shared";

import { canonicalProvider, inferProvider } from "./identity";
import { makeMessage } from "./model";

type Json = Record<string, any>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;

const parseLines = (text: string): Json[] =>
  text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

export const openClawSessionIdFromPath = (sourcePath: string): string => {
  const fileName = sourcePath.split(/[\\/]/).pop() ?? "";
  const sessionId = fileName.split(".jsonl")[0]?.trim();
  return sessionId || "unknown";
};

const usageTokens = (usage: Json) => ({
  cacheRead: num(usage.cacheRead ?? usage.cache_read),
  cacheWrite: num(usage.cacheWrite ?? usage.cache_write),
  input: num(usage.input ?? usage.input_tokens),
  output: num(usage.output ?? usage.output_tokens),
  reasoning: num(usage.reasoning ?? usage.reasoning_tokens),
});

const usageCost = (usage: Json): number => {
  const total = usage.cost?.total ?? usage.cost;
  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? total
    : 0;
};

/** Port of tokscale-core OpenClaw JSONL transcript parser. */
export function parseOpenClaw(
  contents: string,
  sourcePath: string,
  fallback = Date.now()
): UsageMessage[] {
  const sessionId = openClawSessionIdFromPath(sourcePath);
  let currentModel: string | undefined;
  let currentProvider: string | undefined;
  const out: UsageMessage[] = [];
  for (const row of parseLines(contents)) {
    if (row.type === "model_change") {
      if (typeof row.modelId === "string" && row.modelId.trim()) {
        currentModel = row.modelId;
      }
      if (typeof row.provider === "string" && row.provider.trim()) {
        currentProvider = row.provider;
      }
      continue;
    }
    if (row.type === "custom" && row.customType === "model-snapshot") {
      const data = row.data ?? {};
      if (typeof data.modelId === "string" && data.modelId.trim()) {
        currentModel = data.modelId;
      }
      if (typeof data.provider === "string" && data.provider.trim()) {
        currentProvider = data.provider;
      }
      continue;
    }
    if (row.type !== "message") {
      continue;
    }
    const message = row.message;
    if (!message || message.role !== "assistant" || !message.usage) {
      continue;
    }
    const model =
      (typeof message.model === "string" && message.model.trim()
        ? message.model
        : undefined) ?? currentModel;
    if (!model) {
      continue;
    }
    const provider =
      (typeof message.provider === "string" && message.provider.trim()
        ? message.provider
        : undefined) ??
      currentProvider ??
      inferProvider(model) ??
      "unknown";
    currentModel = model;
    currentProvider = provider;
    const timestamp =
      typeof message.timestamp === "number" &&
      Number.isFinite(message.timestamp)
        ? message.timestamp
        : fallback;
    const cost = usageCost(message.usage);
    out.push(
      makeMessage({
        client: "openclaw",
        cost,
        costSource: cost > 0 ? "providerReported" : "unknown",
        modelId: model,
        providerId: canonicalProvider(provider),
        sessionId,
        timestamp,
        tokens: usageTokens(message.usage),
      })
    );
  }
  return out;
}

export function parseOpenClawIndex(
  contents: string,
  indexPath: string,
  readSession: (sessionPath: string) => string | undefined
): UsageMessage[] {
  let parsed: Json;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  const indexDir = dirname(indexPath);
  const out: UsageMessage[] = [];
  for (const entry of Object.values(parsed)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const session = entry as Json;
    const sessionId =
      typeof session.sessionId === "string" ? session.sessionId : undefined;
    if (!sessionId) {
      continue;
    }
    const sessionFile =
      typeof session.sessionFile === "string" && session.sessionFile.trim()
        ? session.sessionFile
        : `${sessionId}.jsonl`;
    const sessionPath = isAbsolute(sessionFile)
      ? sessionFile
      : join(indexDir, sessionFile);
    const text = readSession(sessionPath);
    if (!text) {
      continue;
    }
    out.push(
      ...parseOpenClaw(text, sessionPath).map((message) => ({
        ...message,
        sessionId,
      }))
    );
  }
  return out;
}
