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
  "auto",
  "none",
]);
export function canonicalModelId(id: string): string {
  let name = id.toLowerCase();
  const tier = name.match(/^(.*)\(([^()]*)\)$/);
  if (tier && tier[1] && tier[1].trim() === tier[1] && tiers.has(tier[2]!)) {
    name = tier[1];
  }
  if (/-\d{8}$/.test(name)) {
    name = name.slice(0, -9);
  }
  if (name.includes("claude")) {
    name = name.replaceAll(/(?<=\d)\.(?=\d)/g, "-");
  }
  const anthropic = name.match(
    /^anthropic\/claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/
  );
  return anthropic
    ? `claude-${anthropic[3]}-${anthropic[1]}-${anthropic[2]}`
    : name;
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
    date: Number.isFinite(input.timestamp)
      ? new Date(input.timestamp).toLocaleDateString("en-CA")
      : "",
    isTurnStart: input.isTurnStart ?? false,
    messageCount: input.messageCount ?? 1,
  };
}
