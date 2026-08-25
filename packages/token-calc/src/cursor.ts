/* eslint-disable complexity, func-style, no-use-before-define, prefer-destructuring, prefer-named-capture-group, require-unicode-regexp, unicorn/prefer-array-index-of, unicorn/prefer-number-coercion, unicorn/prefer-string-replace-all */
// CSV column layout follows tokscale-core sessions::cursor.
import type { UsageMessage } from "@toktracker/shared";

import { inferProvider, normalizeWorkspace } from "./identity";
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

export interface ParseCursorCsvOptions {
  agentWorkspaces?: Record<string, string>;
  includeAutomations?: boolean;
  includeCloudAgents?: boolean;
  skipLocalRows?: boolean;
}

const cursorSessionTitle = (
  cloudAgentId: string,
  automationId: string
): string | undefined => {
  if (cloudAgentId) {
    return `Cloud agent ${cloudAgentId}`;
  }
  if (automationId) {
    return `Automation ${automationId}`;
  }
  return undefined;
};

const cursorSessionId = (
  accountId: string,
  dateStr: string,
  cloudAgentId: string,
  automationId: string
): string => {
  if (cloudAgentId) {
    return `cursor-cloud-${cloudAgentId}`;
  }
  if (automationId) {
    return `cursor-automation-${automationId}`;
  }
  return `cursor-${accountId}-${dateStr}`;
};

export const listCursorCsvCloudAgentIds = (contents: string): string[] => {
  const ids = new Set<string>();
  for (const message of parseCursorCsv(contents, "usage.csv", {
    includeAutomations: false,
    includeCloudAgents: true,
    skipLocalRows: true,
  })) {
    const prefix = "cursor-cloud-";
    if (message.sessionId.startsWith(prefix)) {
      ids.add(message.sessionId.slice(prefix.length));
    }
  }
  return [...ids];
};

/** Port of tokscale-core Cursor usage CSV parser (v1/v2/v3 export formats). */
export function parseCursorCsv(
  contents: string,
  sourcePath: string,
  options: ParseCursorCsvOptions = {}
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
    // Cursor's CSV cost is plan/metering-specific (for example, "Included"
    // and "Free"), not the API-equivalent price requested by TokTracker.
    // Keep every Cursor row unpriced so the shared catalog estimates it from
    // tokens. `auto` remains $0 because it is explicitly unpriced there.
    const cost = 0;
    const costSource = "unknown";
    const cloudAgentId =
      cloudAgentIdx >= 0 ? cleanField(fields[cloudAgentIdx]) : "";
    const automationId =
      automationIdx >= 0 ? cleanField(fields[automationIdx]) : "";
    const isCloud = cloudAgentId.length > 0;
    const isAutomation = automationId.length > 0 && !isCloud;
    const isLocal = !(isCloud || isAutomation);
    if (isCloud && options.includeCloudAgents === false) {
      continue;
    }
    if (isAutomation && options.includeAutomations !== true) {
      continue;
    }
    if (isLocal && options.skipLocalRows) {
      continue;
    }
    const sessionTitle = cursorSessionTitle(cloudAgentId, automationId);
    const workspaceRaw = isCloud
      ? options.agentWorkspaces?.[cloudAgentId]
      : undefined;
    const workspace = workspaceRaw
      ? normalizeWorkspace(workspaceRaw)
      : undefined;
    messages.push(
      makeMessage({
        client: "cursor",
        cost,
        costSource,
        dedupKey: `cursor:${accountId}:${dateStr}:${model}:${messages.length}`,
        modelId: model,
        providerId: inferProvider(model) ?? "cursor",
        sessionId: cursorSessionId(
          accountId,
          dateStr,
          cloudAgentId,
          automationId
        ),
        sessionTitle,
        timestamp,
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
        workspaceKey: workspace?.key,
        workspaceLabel: workspace?.label,
      })
    );
  }
  return messages;
}
