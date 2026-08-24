/* eslint-disable prefer-destructuring, unicorn/import-style */
import { homedir } from "node:os";
import { join } from "node:path";

import {
  importDesktopCursorAccounts,
  listCursorAccounts,
  removeCursorAccount,
  resolveCursorPaths,
  setActiveCursorAccount,
  syncCursorUsageCaches,
  upsertCursorAccount,
} from "@toktracker/token-calc";
import type { CursorPaths } from "@toktracker/token-calc";

import { readConfig } from "./runtime-config";

const flagValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
};

const hasFlag = (args: string[], name: string): boolean => args.includes(name);

const cursorUsage = (): string =>
  [
    "Usage:",
    "  toktracker-client cursor login [--name <label>] [--token <session-token>]",
    "  toktracker-client cursor accounts",
    "  toktracker-client cursor switch <id-or-name>",
    "  toktracker-client cursor logout <id-or-name> [--purge-cache]",
    "  toktracker-client cursor sync [--force]",
  ].join("\n");

const clientCursorPaths = async (): Promise<CursorPaths> => {
  const config = await readConfig("client");
  const dataDir = config.TOKTRACKER_DATA_DIR ?? join(homedir(), ".toktracker");
  return resolveCursorPaths(dataDir);
};

export const runCursorCommand = async (args: string[]): Promise<void> => {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log(cursorUsage());
    return;
  }
  const paths = await clientCursorPaths();
  if (action === "login") {
    const label = flagValue(rest, "--name");
    const token = flagValue(rest, "--token");
    if (token) {
      const id = await upsertCursorAccount(paths, token, label);
      console.log(`Saved Cursor account ${id}`);
      return;
    }
    const imported = await importDesktopCursorAccounts(paths);
    if (imported.length === 0) {
      throw new Error(
        "Cursor desktop is not signed in. Open the Cursor app and sign in, or pass --token with a WorkosCursorSessionToken value."
      );
    }
    console.log(
      `Imported ${imported.length} Cursor account(s) from the desktop app: ${imported.join(", ")}`
    );
    return;
  }
  if (action === "accounts") {
    const accounts = await listCursorAccounts(paths);
    if (accounts.length === 0) {
      console.log("No saved Cursor accounts.");
      return;
    }
    for (const account of accounts) {
      const mark = account.isActive ? "*" : " ";
      const label = account.label ? ` (${account.label})` : "";
      console.log(`${mark} ${account.id}${label}`);
    }
    return;
  }
  if (action === "switch") {
    const name = rest[0];
    if (!name) {
      throw new Error("An account id or name is required");
    }
    const id = await setActiveCursorAccount(paths, name);
    console.log(`Active Cursor account is ${id}`);
    return;
  }
  if (action === "logout") {
    const name = rest[0];
    if (!name) {
      throw new Error("An account id or name is required");
    }
    await removeCursorAccount(paths, name, hasFlag(rest, "--purge-cache"));
    console.log(`Removed Cursor account ${name}`);
    return;
  }
  if (action === "sync") {
    const result = await syncCursorUsageCaches(paths, {
      force: hasFlag(rest, "--force"),
    });
    if (!result.synced && result.error) {
      throw new Error(result.error);
    }
    console.log(
      result.synced
        ? `Synced Cursor usage (${result.rows} row(s))`
        : "Cursor usage cache is already fresh"
    );
    return;
  }
  throw new Error(cursorUsage());
};
