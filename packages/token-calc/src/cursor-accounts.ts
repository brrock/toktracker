/* eslint-disable complexity, func-style, no-await-in-loop, no-nested-ternary, prefer-destructuring, require-await, require-unicode-regexp, typescript/no-dynamic-delete, unicorn/import-style, unicorn/no-await-expression-member, unicorn/no-nested-ternary, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */
// Cursor desktop auth and multi-account usage export, ported from tokscale-cli.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { isCursorUsageCsvFilename } from "./cursor";

const USAGE_CSV_ENDPOINT =
  "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
const AUTO_SYNC_FRESHNESS_MS = 5 * 60 * 1000;
const SYNC_ATTEMPT_MARKER = "usage.last-sync-attempt";

export interface CursorAccount {
  createdAt: string;
  label?: string;
  sessionToken: string;
  userId?: string;
}

export interface CursorAccountStore {
  accounts: Record<string, CursorAccount>;
  activeAccountId: string;
  version: 1;
}

export interface CursorAccountInfo {
  createdAt: string;
  id: string;
  isActive: boolean;
  label?: string;
  userId?: string;
}

export type CursorFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface CursorSyncResult {
  error?: string;
  rows: number;
  synced: boolean;
}

export interface CursorPaths {
  cacheDir: string;
  credentialsPath: string;
  dataDir: string;
  homeDir: string;
}

const defaultHomeDir = (): string =>
  process.env.HOME ?? process.env.USERPROFILE ?? homedir();

export const resolveCursorPaths = (
  dataDir: string,
  homeDir = defaultHomeDir()
): CursorPaths => ({
  cacheDir: join(dataDir, "cursor-cache"),
  credentialsPath: join(dataDir, "cursor-credentials.json"),
  dataDir,
  homeDir,
});

export const sanitizeAccountIdForFilename = (accountId: string): string => {
  const sanitized = accountId
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "account";
};

export const extractUserIdFromSessionToken = (
  token: string
): string | undefined => {
  const trimmed = token.trim();
  const encoded = trimmed.split("%3A%3A")[0]?.trim();
  if (trimmed.includes("%3A%3A") && encoded) {
    return encoded;
  }
  const plain = trimmed.split("::")[0]?.trim();
  if (trimmed.includes("::") && plain) {
    return plain;
  }
  return undefined;
};

const userIdFromAccessTokenJwt = (accessToken: string): string | undefined => {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const json = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    ) as {
      sub?: unknown;
    };
    const sub = typeof json.sub === "string" ? json.sub : "";
    const match = /user_[A-Za-z0-9_]+/.exec(sub);
    return match?.[0];
  } catch {
    return undefined;
  }
};

export const sessionTokenFromAccessToken = (
  accessToken: string
): string | undefined => {
  const userId = userIdFromAccessTokenJwt(accessToken);
  if (!userId) {
    return undefined;
  }
  return `${userId}%3A%3A${accessToken}`;
};

export const normalizeCursorSessionToken = (token: string): string => {
  const trimmed = token.trim();
  if (trimmed.includes("%3A%3A")) {
    return trimmed;
  }
  if (trimmed.includes("::")) {
    const [userId, ...rest] = trimmed.split("::");
    return `${userId}%3A%3A${rest.join("::")}`;
  }
  return sessionTokenFromAccessToken(trimmed) ?? trimmed;
};

export const deriveAccountId = (sessionToken: string): string => {
  const userId = extractUserIdFromSessionToken(sessionToken);
  if (userId) {
    return userId;
  }
  const hash = Bun.hash(sessionToken).toString(16).slice(0, 12);
  return `anon-${hash}`;
};

export const cursorStateVscdbCandidates = (homeDir: string): string[] => {
  const appData = process.env.APPDATA ?? join(homeDir, "AppData", "Roaming");
  const mac = join(homeDir, "Library", "Application Support");
  const linux = process.env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  const roots =
    platform() === "darwin"
      ? [mac]
      : platform() === "win32"
        ? [appData]
        : [linux];
  const apps = ["Cursor", "Cursor Nightly", "cursor"];
  const paths: string[] = [];
  for (const root of roots) {
    for (const app of apps) {
      paths.push(join(root, app, "User", "globalStorage", "state.vscdb"));
    }
  }
  return paths;
};

const extraCursorStateVscdbPaths = (homeDir: string): string[] => {
  const extra: string[] = [];
  for (const candidate of cursorStateVscdbCandidates(homeDir)) {
    const userDir = candidate.replace(
      /[/\\]globalStorage[/\\]state\.vscdb$/u,
      ""
    );
    const glob = new Bun.Glob("profiles/*/globalStorage/state.vscdb");
    try {
      for (const path of glob.scanSync({
        absolute: true,
        cwd: userDir,
        onlyFiles: true,
      })) {
        extra.push(path);
      }
    } catch {
      // Profile directories are optional.
    }
  }
  return extra;
};

const readAccessTokenFromStateVscdb = (dbPath: string): string | undefined => {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
      .get() as { value: string } | null;
    const emailRow = db
      .query("SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail'")
      .get() as { value: string } | null;
    db.close();
    const token = row?.value?.trim();
    if (!token) {
      return undefined;
    }
    return emailRow?.value ? `${token}\n${emailRow.value}` : token;
  } catch {
    return undefined;
  }
};

export interface DesktopCursorSession {
  email?: string;
  path: string;
  sessionToken: string;
}

export const readDesktopCursorSessions = (
  homeDir = defaultHomeDir()
): DesktopCursorSession[] => {
  const sessions: DesktopCursorSession[] = [];
  const seen = new Set<string>();
  const dbPaths = [
    ...cursorStateVscdbCandidates(homeDir),
    ...extraCursorStateVscdbPaths(homeDir),
  ];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) {
      continue;
    }
    const raw = readAccessTokenFromStateVscdb(dbPath);
    if (!raw) {
      continue;
    }
    const [tokenLine, emailLine] = raw.split("\n");
    if (!tokenLine) {
      continue;
    }
    const sessionToken = normalizeCursorSessionToken(tokenLine);
    const accountId = deriveAccountId(sessionToken);
    if (seen.has(accountId)) {
      continue;
    }
    seen.add(accountId);
    sessions.push({
      email: emailLine?.trim() || undefined,
      path: dbPath,
      sessionToken,
    });
  }
  return sessions;
};

const emptyStore = (): CursorAccountStore => ({
  accounts: {},
  activeAccountId: "",
  version: 1,
});

export const loadCursorAccountStore = async (
  paths: CursorPaths
): Promise<CursorAccountStore> => {
  const file = Bun.file(paths.credentialsPath);
  if (!(await file.exists())) {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(await file.text()) as CursorAccountStore;
    if (parsed.version === 1 && parsed.accounts) {
      if (!parsed.accounts[parsed.activeAccountId]) {
        parsed.activeAccountId = Object.keys(parsed.accounts)[0] ?? "";
      }
      return parsed;
    }
  } catch {
    return emptyStore();
  }
  return emptyStore();
};

export const saveCursorAccountStore = async (
  paths: CursorPaths,
  store: CursorAccountStore
): Promise<void> => {
  await mkdir(paths.dataDir, { recursive: true });
  await Bun.write(paths.credentialsPath, `${JSON.stringify(store, null, 2)}\n`);
  if (platform() !== "win32") {
    await chmod(paths.credentialsPath, 0o600);
  }
};

export const upsertCursorAccount = async (
  paths: CursorPaths,
  sessionToken: string,
  label?: string
): Promise<string> => {
  const token = normalizeCursorSessionToken(sessionToken);
  const accountId = deriveAccountId(token);
  const store = await loadCursorAccountStore(paths);
  if (label) {
    const needle = label.trim().toLowerCase();
    for (const [id, account] of Object.entries(store.accounts)) {
      if (id !== accountId && account.label?.trim().toLowerCase() === needle) {
        throw new Error(`Cursor account label already exists: ${label}`);
      }
    }
  }
  const existing = store.accounts[accountId];
  store.accounts[accountId] = {
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    label: label ?? existing?.label,
    sessionToken: token,
    userId: extractUserIdFromSessionToken(token),
  };
  store.activeAccountId = accountId;
  store.version = 1;
  await saveCursorAccountStore(paths, store);
  return accountId;
};

export const importDesktopCursorAccounts = async (
  paths: CursorPaths
): Promise<string[]> => {
  const imported: string[] = [];
  for (const session of readDesktopCursorSessions(paths.homeDir)) {
    const id = await upsertCursorAccount(
      paths,
      session.sessionToken,
      session.email
    );
    imported.push(id);
  }
  return imported;
};

export const listCursorAccounts = async (
  paths: CursorPaths
): Promise<CursorAccountInfo[]> => {
  const store = await loadCursorAccountStore(paths);
  return Object.entries(store.accounts)
    .map(([id, account]) => ({
      createdAt: account.createdAt,
      id,
      isActive: id === store.activeAccountId,
      label: account.label,
      userId: account.userId,
    }))
    .toSorted((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }
      return (left.label ?? left.id).localeCompare(right.label ?? right.id);
    });
};

const resolveAccountId = (
  store: CursorAccountStore,
  nameOrId: string
): string | undefined => {
  const needle = nameOrId.trim();
  if (store.accounts[needle]) {
    return needle;
  }
  const lower = needle.toLowerCase();
  return Object.entries(store.accounts).find(
    ([, account]) => account.label?.trim().toLowerCase() === lower
  )?.[0];
};

export const setActiveCursorAccount = async (
  paths: CursorPaths,
  nameOrId: string
): Promise<string> => {
  const store = await loadCursorAccountStore(paths);
  const resolved = resolveAccountId(store, nameOrId);
  if (!resolved) {
    throw new Error(`Cursor account not found: ${nameOrId}`);
  }
  store.activeAccountId = resolved;
  await saveCursorAccountStore(paths, store);
  return resolved;
};

export const removeCursorAccount = async (
  paths: CursorPaths,
  nameOrId: string,
  purgeCache: boolean
): Promise<void> => {
  const store = await loadCursorAccountStore(paths);
  const resolved = resolveAccountId(store, nameOrId);
  if (!resolved) {
    throw new Error(`Cursor account not found: ${nameOrId}`);
  }
  delete store.accounts[resolved];
  if (purgeCache) {
    const active = join(paths.cacheDir, "usage.csv");
    const named = join(
      paths.cacheDir,
      `usage.${sanitizeAccountIdForFilename(resolved)}.csv`
    );
    await Promise.all(
      [active, named].map(async (path) => {
        if (existsSync(path)) {
          await unlink(path);
        }
      })
    );
  }
  if (store.activeAccountId === resolved) {
    store.activeAccountId = Object.keys(store.accounts)[0] ?? "";
  }
  if (Object.keys(store.accounts).length === 0) {
    await Bun.write(paths.credentialsPath, "");
    return;
  }
  await saveCursorAccountStore(paths, store);
};

export const cursorCacheDirectories = (paths: CursorPaths): string[] => {
  const dirs = [
    paths.cacheDir,
    join(paths.homeDir, ".config", "tokscale", "cursor-cache"),
    join(paths.homeDir, ".tokscale", "cursor-cache"),
  ];
  return [...new Set(dirs)];
};

const cachePathForAccount = (
  cacheDir: string,
  accountId: string,
  activeAccountId: string
): string =>
  accountId === activeAccountId
    ? join(cacheDir, "usage.csv")
    : join(cacheDir, `usage.${sanitizeAccountIdForFilename(accountId)}.csv`);

const fileIsFresh = async (
  path: string,
  maxAgeMs: number
): Promise<boolean> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return false;
  }
  const age = Date.now() - (await file.stat()).mtimeMs;
  return age >= 0 && age < maxAgeMs;
};

export const fetchCursorUsageCsv = async (
  sessionToken: string,
  fetchImpl: CursorFetch = fetch
): Promise<string> => {
  const response = await fetchImpl(USAGE_CSV_ENDPOINT, {
    headers: {
      Accept: "*/*",
      Cookie: `WorkosCursorSessionToken=${sessionToken}`,
      Referer: "https://cursor.com/settings",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Cursor session expired");
  }
  if (!response.ok) {
    throw new Error(`Cursor API returned status ${response.status}`);
  }
  const text = await response.text();
  if (!text.startsWith("Date,")) {
    throw new Error("Invalid response from Cursor API - expected CSV format");
  }
  return text;
};

const countCsvRows = (csv: string): number =>
  Math.max(0, csv.split(/\r?\n/).filter((line) => line.trim()).length - 1);

export const syncCursorUsageCaches = async (
  paths: CursorPaths,
  options?: {
    fetchImpl?: CursorFetch;
    force?: boolean;
  }
): Promise<CursorSyncResult> => {
  await importDesktopCursorAccounts(paths);
  const store = await loadCursorAccountStore(paths);
  if (Object.keys(store.accounts).length === 0) {
    return { error: "Not authenticated", rows: 0, synced: false };
  }
  await mkdir(paths.cacheDir, { recursive: true });
  if (platform() !== "win32") {
    await chmod(paths.cacheDir, 0o700);
  }
  if (!options?.force) {
    const expected = Object.keys(store.accounts).map((id) =>
      cachePathForAccount(paths.cacheDir, id, store.activeAccountId)
    );
    const markerFresh = await fileIsFresh(
      join(paths.cacheDir, SYNC_ATTEMPT_MARKER),
      AUTO_SYNC_FRESHNESS_MS
    );
    const activePath = join(paths.cacheDir, "usage.csv");
    const activeFresh = await fileIsFresh(activePath, AUTO_SYNC_FRESHNESS_MS);
    const restFresh = (
      await Promise.all(
        expected
          .filter((path) => path !== activePath)
          .map(async (path) => fileIsFresh(path, AUTO_SYNC_FRESHNESS_MS))
      )
    ).every(Boolean);
    if (activeFresh && (restFresh || markerFresh)) {
      return { rows: 0, synced: false };
    }
  }
  let rows = 0;
  let success = 0;
  const errors: string[] = [];
  for (const [accountId, account] of Object.entries(store.accounts)) {
    try {
      const csv = await fetchCursorUsageCsv(
        account.sessionToken,
        options?.fetchImpl
      );
      const path = cachePathForAccount(
        paths.cacheDir,
        accountId,
        store.activeAccountId
      );
      await Bun.write(path, csv);
      rows += countCsvRows(csv);
      success += 1;
    } catch (error) {
      errors.push(
        `${accountId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  await Bun.write(join(paths.cacheDir, SYNC_ATTEMPT_MARKER), `${Date.now()}\n`);
  if (success === 0) {
    return {
      error: errors[0] ?? "Cursor sync failed",
      rows: 0,
      synced: false,
    };
  }
  return {
    error: errors.length > 0 ? errors.join("; ") : undefined,
    rows,
    synced: true,
  };
};

export const listCursorUsageCsvFiles = async (
  paths: CursorPaths
): Promise<string[]> => {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const dir of cursorCacheDirectories(paths)) {
    const glob = new Bun.Glob("usage*.csv");
    try {
      for await (const path of glob.scan({
        absolute: true,
        cwd: dir,
        onlyFiles: true,
      })) {
        const name = path.split(/[\\/]/).pop() ?? "";
        if (!isCursorUsageCsvFilename(name) || seen.has(path)) {
          continue;
        }
        seen.add(path);
        files.push(path);
      }
    } catch {
      // Cache directories are optional.
    }
  }
  return files.toSorted();
};
