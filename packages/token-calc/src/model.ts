/* eslint-disable func-style, prefer-destructuring, prefer-named-capture-group, require-unicode-regexp, typescript/no-non-null-assertion */
// Canonicalization expressions mirror tokscale's model-id grammar.
import type { TokenBreakdown, UsageMessage } from "@toktracker/shared";

export const zeroTokens = (): TokenBreakdown => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  reasoning: 0,
});
export const totalTokens = (t: TokenBreakdown) =>
  t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;

const tiers = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
  "none",
]);
const providerPrefixes = new Set([
  "anthropic",
  "cursor",
  "google",
  "openai",
  "xai",
]);
const thinkingSuffix =
  /^(.*)-(thinking(?:-(?:minimal|low|medium|high|xhigh|max|auto|none))?)$/;
const versionEffortSuffix =
  /^(.*?[0-9]+(?:[.-][0-9]+)*)-(minimal|low|medium|high|xhigh|max|auto|none)$/;
const modelFamily =
  /^(claude|codex|composer|deepseek|gemini|glm|gpt|grok|kimi|llama|mistral|o[1-9]|qwen)\b/;

const stripEffortSuffix = (name: string): string => {
  const thinking = name.match(thinkingSuffix);
  if (thinking?.[1]) {
    return thinking[1];
  }
  const versioned = name.match(versionEffortSuffix);
  return versioned?.[1] ?? name;
};

const stripProviderPrefix = (name: string): string => {
  const slash = name.indexOf("/");
  if (slash > 0) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    if (providerPrefixes.has(prefix) && modelFamily.test(rest)) {
      return rest;
    }
  }
  const hyphen = name.indexOf("-");
  if (hyphen > 0) {
    const prefix = name.slice(0, hyphen);
    const rest = name.slice(hyphen + 1);
    if (providerPrefixes.has(prefix) && modelFamily.test(rest)) {
      return rest;
    }
  }
  return name;
};

function computeCanonicalModelId(id: string): string {
  let name = id.toLowerCase();
  const tier = name.match(/^(.*)(?:\s*)\(([^()]*)\)$/);
  if (tier?.[1] && tiers.has(tier[2]!.trim())) {
    name = tier[1].trimEnd();
  }
  if (/-\d{8}$/.test(name)) {
    name = name.slice(0, -9);
  }
  name = stripEffortSuffix(name);
  if (name.includes("claude")) {
    name = name.replaceAll(/(?<=\d)\.(?=\d)/g, "-");
  }
  const anthropic = name.match(
    /^anthropic\/claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/
  );
  if (anthropic) {
    return `claude-${anthropic[3]}-${anthropic[1]}-${anthropic[2]}`;
  }
  return stripProviderPrefix(name);
}

// Canonicalization runs several regexes and is called for every message in
// every dashboard summary, but the set of distinct model IDs is tiny.
const MAX_CANONICAL_MODEL_CACHE = 10_000;
const canonicalModelCache = new Map<string, string>();

export function canonicalModelId(id: string): string {
  const cached = canonicalModelCache.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const canonical = computeCanonicalModelId(id);
  if (canonicalModelCache.size >= MAX_CANONICAL_MODEL_CACHE) {
    canonicalModelCache.clear();
  }
  canonicalModelCache.set(id, canonical);
  return canonical;
}

const padDatePart = (value: number): string =>
  value.toString().padStart(2, "0");

/**
 * Local YYYY-MM-DD, equivalent to toLocaleDateString("en-CA") without the
 * per-call Intl formatting cost (this runs once per parsed message).
 */
function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Invalid Date";
  }
  const year = date.getFullYear();
  if (year < 1000 || year > 9999) {
    return date.toLocaleDateString("en-CA");
  }
  return `${year}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function makeMessage(
  input: Omit<
    UsageMessage,
    "date" | "costSource" | "messageCount" | "isTurnStart"
  > &
    Partial<Pick<UsageMessage, "costSource" | "messageCount" | "isTurnStart">>
): UsageMessage {
  return {
    ...input,
    costSource: input.costSource ?? "unknown",
    date: Number.isFinite(input.timestamp) ? localDate(input.timestamp) : "",
    isTurnStart: input.isTurnStart ?? false,
    messageCount: input.messageCount ?? 1,
  };
}
