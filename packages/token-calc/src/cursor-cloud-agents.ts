/* eslint-disable complexity, func-style, no-await-in-loop, unicorn/import-style, unicorn/text-encoding-identifier-case, prefer-destructuring, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CursorFetch } from "./cursor-accounts";

const CLOUD_AGENT_API = "https://api.cursor.com/v1/agents";
const CACHE_VERSION = 1;
const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

export interface CloudAgentWorkspaceCache {
  agents: Record<string, CloudAgentWorkspaceEntry>;
  version: 1;
}

export interface CloudAgentWorkspaceEntry {
  fetchedAt: number;
  workspace: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const stringField = (
  record: Record<string, unknown> | undefined,
  key: string
): string => {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
};

export const workspaceFromGitUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname
      .replace(/\.git$/u, "")
      .split("/")
      .filter(Boolean);
    return segments.at(-1) ?? "";
  } catch {
    const segments = trimmed
      .replace(/\.git$/u, "")
      .split(/[/\\]/u)
      .filter(Boolean);
    return segments.at(-1) ?? "";
  }
};

export const workspaceFromCloudAgentPayload = (payload: unknown): string => {
  const root = asRecord(payload);
  const agent = asRecord(root?.agent) ?? root;
  if (!agent) {
    return "";
  }
  const repos = agent.repos;
  if (Array.isArray(repos)) {
    for (const repo of repos) {
      const record = asRecord(repo);
      const url =
        stringField(record, "url") || stringField(record, "repository");
      const fromUrl = workspaceFromGitUrl(url);
      if (fromUrl) {
        return url.includes("://") ? url : fromUrl;
      }
    }
  }
  const source = asRecord(agent.source);
  const repository =
    stringField(source, "repository") || stringField(source, "url");
  if (repository) {
    return repository.includes("://")
      ? repository
      : workspaceFromGitUrl(repository);
  }
  return stringField(agent, "name");
};

const basicAuthHeader = (apiKey: string): string =>
  `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;

const emptyCache = (): CloudAgentWorkspaceCache => ({
  agents: {},
  version: CACHE_VERSION,
});

export const readCloudAgentWorkspaceCache = async (
  cachePath: string
): Promise<CloudAgentWorkspaceCache> => {
  const file = Bun.file(cachePath);
  if (!(await file.exists())) {
    return emptyCache();
  }
  try {
    const parsed = (await file.json()) as CloudAgentWorkspaceCache;
    if (parsed.version !== CACHE_VERSION || typeof parsed.agents !== "object") {
      return emptyCache();
    }
    return parsed;
  } catch {
    return emptyCache();
  }
};

const writeCloudAgentWorkspaceCache = async (
  cachePath: string,
  cache: CloudAgentWorkspaceCache
): Promise<void> => {
  await mkdir(dirname(cachePath), { recursive: true });
  await Bun.write(cachePath, `${JSON.stringify(cache, undefined, 2)}\n`);
};

const fetchOneCloudAgent = async (
  agentId: string,
  apiKey: string,
  fetchImpl: CursorFetch
): Promise<string> => {
  const response = await fetchImpl(
    `${CLOUD_AGENT_API}/${encodeURIComponent(agentId)}`,
    {
      headers: {
        authorization: basicAuthHeader(apiKey),
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      `Cloud agent ${agentId} returned status ${response.status}`
    );
  }
  return workspaceFromCloudAgentPayload(await response.json());
};

export const fetchCloudAgentWorkspaces = async (
  agentIds: string[],
  options: {
    apiKey: string;
    cacheMaxAgeMs?: number;
    cachePath?: string;
    fetchImpl?: CursorFetch;
  }
): Promise<Record<string, string>> => {
  const uniqueIds = [...new Set(agentIds.filter(Boolean))];
  const cache = options.cachePath
    ? await readCloudAgentWorkspaceCache(options.cachePath)
    : emptyCache();
  const maxAge = options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  const now = Date.now();
  const workspaces: Record<string, string> = {};
  const stale: string[] = [];
  for (const agentId of uniqueIds) {
    const cached = cache.agents[agentId];
    if (cached?.workspace && now - cached.fetchedAt < maxAge) {
      workspaces[agentId] = cached.workspace;
      continue;
    }
    stale.push(agentId);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let index = 0; index < stale.length; index += FETCH_CONCURRENCY) {
    const batch = stale.slice(index, index + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (agentId) => {
        const workspace = await fetchOneCloudAgent(
          agentId,
          options.apiKey,
          fetchImpl
        );
        return { agentId, workspace };
      })
    );
    for (const result of results) {
      if (result.status !== "fulfilled") {
        continue;
      }
      const { agentId, workspace } = result.value;
      if (!workspace) {
        continue;
      }
      workspaces[agentId] = workspace;
      cache.agents[agentId] = { fetchedAt: now, workspace };
    }
  }
  if (options.cachePath && stale.length > 0) {
    await writeCloudAgentWorkspaceCache(options.cachePath, cache);
  }
  return workspaces;
};
