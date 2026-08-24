/* eslint-disable complexity, func-style, no-use-before-define, prefer-destructuring, prefer-named-capture-group, require-unicode-regexp, unicorn/prefer-array-index-of, unicorn/prefer-number-coercion, unicorn/prefer-string-replace-all */
// CSV column layout follows tokscale-core sessions::cursor.
import type { UsageMessage } from "@toktracker/shared";

import { inferProvider } from "./identity";
import { canonicalModelId, makeMessage } from "./model";

const parseCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
};

const cleanField = (value: string | undefined): string =>
  (value ?? "").trim().replace(/^"|"$/g, "").trim();

const parseFiniteCost = (costStr: string): number | undefined => {
  const cleaned = costStr.replaceAll(/[$,]/g, "").trim();
  const cost = Number(cleaned);
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
};

const parseDateToTimestamp = (dateStr: string): number => {
  const iso = Date.parse(dateStr);
  if (Number.isFinite(iso)) {
    return iso;
  }
  const day = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!day) {
    return 0;
  }
  return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12, 0, 0);
};

const columnIndex = (headers: string[], name: string): number =>
  headers.findIndex((header) => header === name);

export const accountIdFromCursorCachePath = (path: string): string => {
  const fileName = path.split(/[\\/]/).pop() ?? "usage.csv";
  if (fileName === "usage.csv") {
    return "active";
  }
  const stem = fileName.replace(/^usage\./, "").replace(/\.csv$/, "");
  const cleaned = stem.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return cleaned || "unknown";
};

export const isCursorUsageCsvFilename = (name: string): boolean => {
  if (name === "usage.csv") {
    return true;
  }
  if (!name.startsWith("usage.") || !name.endsWith(".csv")) {
    return false;
  }
  if (name.startsWith("usage.backup") || name === "usage.last-sync-attempt") {
    return false;
  }
  const stem = name.slice("usage.".length, -".csv".length);
  return (
    stem.length > 0 &&
    [...stem].every(
      (char) =>
        (char >= "a" && char <= "z") ||
        (char >= "A" && char <= "Z") ||
        (char >= "0" && char <= "9") ||
        char === "." ||
        char === "_" ||
        char === "-"
    )
  );
};

interface CursorWorkspace {
  workspaceKey?: string;
  workspaceLabel?: string;
}

const cursorWorkspace = (
  cloudAgentId: string,
  automationId: string
): CursorWorkspace => {
  if (cloudAgentId) {
    return {
      workspaceKey: `cursor-cloud-agent:${cloudAgentId}`,
      workspaceLabel: `Cloud agent ${cloudAgentId}`,
    };
  }
  if (automationId) {
    return {
      workspaceKey: `cursor-automation:${automationId}`,
      workspaceLabel: `Automation ${automationId}`,
    };
  }
  return {};
};

/** Port of tokscale-core Cursor usage CSV parser (v1/v2/v3 export formats). */
export function parseCursorCsv(
  contents: string,
  sourcePath: string
): UsageMessage[] {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim());
  const headerLine = lines[0];
  if (
    !headerLine ||
    !headerLine.includes("Date") ||
    !headerLine.includes("Model")
  ) {
    return [];
  }
  const headers = parseCsvLine(headerLine).map((header) => cleanField(header));
  const dateIdx = columnIndex(headers, "Date");
  const modelIdx = columnIndex(headers, "Model");
  const inputCacheWriteIdx = columnIndex(headers, "Input (w/ Cache Write)");
  const inputNoCacheIdx = columnIndex(headers, "Input (w/o Cache Write)");
  const cacheReadIdx = columnIndex(headers, "Cache Read");
  const outputIdx = columnIndex(headers, "Output Tokens");
  const namedCost = columnIndex(headers, "Cost");
  const costIdx =
    namedCost === -1 ? columnIndex(headers, "Cost to you") : namedCost;
  const cloudAgentIdx = columnIndex(headers, "Cloud Agent ID");
  const automationIdx = columnIndex(headers, "Automation ID");
  if (
    dateIdx < 0 ||
    modelIdx < 0 ||
    inputCacheWriteIdx < 0 ||
    inputNoCacheIdx < 0 ||
    cacheReadIdx < 0 ||
    outputIdx < 0 ||
    costIdx < 0
  ) {
    return [];
  }
  const accountId = accountIdFromCursorCachePath(sourcePath);
  const messages: UsageMessage[] = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const model = canonicalModelId(cleanField(fields[modelIdx]));
    if (!model) {
      continue;
    }
    const dateStr = cleanField(fields[dateIdx]);
    const timestamp = parseDateToTimestamp(dateStr);
    if (!timestamp) {
      continue;
    }
    const cost = parseFiniteCost(cleanField(fields[costIdx]));
    const cloudAgentId =
      cloudAgentIdx >= 0 ? cleanField(fields[cloudAgentIdx]) : "";
    const automationId =
      automationIdx >= 0 ? cleanField(fields[automationIdx]) : "";
    const workspace = cursorWorkspace(cloudAgentId, automationId);
    messages.push(
      makeMessage({
        client: "cursor",
        cost: cost ?? 0,
        costSource: cost === undefined ? "unknown" : "providerReported",
        dedupKey: `cursor:${accountId}:${dateStr}:${model}:${messages.length}`,
        modelId: model,
        providerId: inferProvider(model) ?? "cursor",
        sessionId: `cursor-${accountId}-${dateStr}`,
        timestamp,
        ...workspace,
        tokens: {
          cacheRead: Math.max(
            0,
            Number.parseInt(cleanField(fields[cacheReadIdx]), 10) || 0
          ),
          cacheWrite: Math.max(
            0,
            Number.parseInt(cleanField(fields[inputCacheWriteIdx]), 10) || 0
          ),
          input: Math.max(
            0,
            Number.parseInt(cleanField(fields[inputNoCacheIdx]), 10) || 0
          ),
          output: Math.max(
            0,
            Number.parseInt(cleanField(fields[outputIdx]), 10) || 0
          ),
          reasoning: 0,
        },
      })
    );
  }
  return messages;
}
