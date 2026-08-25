/* eslint-disable complexity, func-style, no-await-in-loop, require-unicode-regexp, unicorn/import-style, unicorn/prefer-number-properties, unicorn/text-encoding-identifier-case, eslint/prefer-destructuring, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UsageMessage } from "@toktracker/shared";

import { inferProvider, normalizeWorkspace } from "./identity";
import { canonicalModelId, makeMessage, zeroTokens } from "./model";

interface T3CursorRow {
  created_at: string | number | null;
  model: string | null;
  model_selection_json: string | null;
  project_title: string | null;
  provider_name: string | null;
  thread_id: string;
  title: string | null;
  updated_at: string | number | null;
  workspace_root: string | null;
}

const defaultHomeDir = (): string =>
  process.env.HOME ?? process.env.USERPROFILE ?? homedir();

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

export const t3CodeStateSqliteCandidates = (
  homeDir = defaultHomeDir(),
  t3Home?: string
): string[] => {
  const bases = new Set<string>();
  const explicit = t3Home?.trim() || process.env.T3CODE_HOME?.trim();
  if (explicit) {
    bases.add(explicit);
  }
  bases.add(join(homeDir, ".t3"));
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (const relative of [
      "userdata/state.sqlite",
      "dev/userdata/state.sqlite",
    ]) {
      const sqlitePath = join(base, relative);
      if (seen.has(sqlitePath)) {
        continue;
      }
      seen.add(sqlitePath);
      paths.push(sqlitePath);
    }
  }
  return paths;
};

export const listT3CodeStateSqliteFiles = (
  homeDir = defaultHomeDir(),
  t3Home?: string
): string[] =>
  t3CodeStateSqliteCandidates(homeDir, t3Home).filter((path) =>
    existsSync(path)
  );

const tableColumns = (db: Database, table: string): Set<string> => {
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
};

const timestampFromT3 = (value: string | number | null | undefined): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const modelFromSelectionJson = (raw: string | null | undefined): string => {
  if (!raw?.trim()) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    const nested = asRecord(record?.options) ?? asRecord(record?.selection);
    const model =
      (typeof record?.model === "string" && record.model) ||
      (typeof nested?.model === "string" && nested.model) ||
      "";
    return model.trim();
  } catch {
    return "";
  }
};

const isCursorProvider = (name: string | null | undefined): boolean => {
  const value = name?.trim().toLowerCase() ?? "";
  return value.includes("cursor");
};

export function parseT3CodeCursorSqlite(path: string): UsageMessage[] {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, strict: true });
  } catch {
    return [];
  }
  try {
    const threadCols = tableColumns(db, "projection_threads");
    const sessionCols = tableColumns(db, "projection_thread_sessions");
    const projectCols = tableColumns(db, "projection_projects");
    if (
      threadCols.size === 0 ||
      sessionCols.size === 0 ||
      !threadCols.has("thread_id") ||
      !sessionCols.has("provider_name")
    ) {
      return [];
    }
    const modelColumn = threadCols.has("model") ? "t.model" : "NULL";
    const selectionColumn = threadCols.has("model_selection_json")
      ? "t.model_selection_json"
      : "NULL";
    const workspaceColumn = projectCols.has("workspace_root")
      ? "p.workspace_root"
      : "NULL";
    const projectTitleColumn = projectCols.has("title") ? "p.title" : "NULL";
    const deletedClause = threadCols.has("deleted_at")
      ? "AND t.deleted_at IS NULL"
      : "";
    const joinProjects =
      projectCols.size > 0
        ? "LEFT JOIN projection_projects p ON p.project_id = t.project_id"
        : "";
    const sql = `
      SELECT
        t.thread_id AS thread_id,
        t.title AS title,
        t.created_at AS created_at,
        t.updated_at AS updated_at,
        ${modelColumn} AS model,
        ${selectionColumn} AS model_selection_json,
        ts.provider_name AS provider_name,
        ${workspaceColumn} AS workspace_root,
        ${projectTitleColumn} AS project_title
      FROM projection_thread_sessions ts
      JOIN projection_threads t ON t.thread_id = ts.thread_id
      ${joinProjects}
      WHERE ts.provider_name IS NOT NULL
        ${deletedClause}
    `;
    const rows = db.query(sql).all() as T3CursorRow[];
    const messages: UsageMessage[] = [];
    for (const row of rows) {
      if (!isCursorProvider(row.provider_name)) {
        continue;
      }
      const timestamp =
        timestampFromT3(row.created_at) || timestampFromT3(row.updated_at);
      if (!timestamp) {
        continue;
      }
      const selected = modelFromSelectionJson(row.model_selection_json);
      const fallback = row.model?.trim() ?? "";
      const model =
        (selected ? canonicalModelId(selected) : "") ||
        (fallback ? canonicalModelId(fallback) : "") ||
        "unknown";
      const workspace = normalizeWorkspace(row.workspace_root ?? undefined);
      const title = row.title?.replaceAll(/\s+/gu, " ").trim();
      messages.push(
        makeMessage({
          client: "cursor",
          cost: 0,
          costSource: "unknown",
          dedupKey: `cursor-t3:${row.thread_id}`,
          modelId: model,
          providerId: inferProvider(model) ?? "cursor",
          sessionId: `cursor-t3-${row.thread_id}`,
          sessionTitle: title ? title.slice(0, 160) : undefined,
          timestamp,
          tokens: zeroTokens(),
          workspaceKey: workspace.key,
          workspaceLabel: workspace.label ?? row.project_title ?? undefined,
        })
      );
    }
    return messages;
  } catch {
    return [];
  } finally {
    db.close();
  }
}
