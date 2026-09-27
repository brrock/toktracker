/* eslint-disable prefer-destructuring, unicorn/import-style */
import { homedir } from "node:os";
import { join } from "node:path";

import type { CursorPaths } from "../../token-calc/src/index.ts";
import {
  importDesktopCursorAccounts,
  listCursorAccounts,
  removeCursorAccount,
  resolveCursorPaths,
  setActiveCursorAccount,
  syncCursorUsageCaches,
  upsertCursorAccount,
} from "../../token-calc/src/index.ts";
import { parseArgs } from "./args";
import { readConfig } from "./runtime-config";
import {
  bold,
  CliError,
  didYouMean,
  dim,
  formatTable,
  green,
  printInfo,
  printSuccess,
  usageError,
} from "./ui";

const HELP_COMMAND = "toktracker-client cursor";
const ACTIONS = ["accounts", "login", "logout", "switch", "sync"];

const requireAccount = (value: string | undefined): string => {
  if (!value) {
    throw usageError(
      "An account ID or name is required",
      `List accounts with ${bold(`${HELP_COMMAND} accounts`)}.`
    );
  }
  return value;
};

const clientCursorPaths = async (): Promise<CursorPaths> => {
  const config = await readConfig("client");
  const dataDir = config.TOKTRACKER_DATA_DIR ?? join(homedir(), ".toktracker");
  return resolveCursorPaths(dataDir);
};

export const runCursorCommand = async (args: string[]): Promise<void> => {
  const [action = "", ...rest] = args;
  if (!ACTIONS.includes(action)) {
    throw usageError(
      `Unknown cursor action "${action}"`,
      didYouMean(action, ACTIONS) ?? `Run ${HELP_COMMAND} --help for usage.`
    );
  }
  const paths = await clientCursorPaths();
  if (action === "login") {
    const parsed = parseArgs(
      rest,
      { values: ["--name", "--token"] },
      HELP_COMMAND
    );
    const label = parsed.values.get("--name");
    const token = parsed.values.get("--token");
    if (token) {
      const id = await upsertCursorAccount(paths, token, label);
      printSuccess(`Saved Cursor account ${bold(id)}`);
      return;
    }
    const imported = await importDesktopCursorAccounts(paths);
    if (imported.length === 0) {
      throw new CliError(
        "Cursor desktop is not signed in",
        "Open the Cursor app and sign in, or pass --token with a WorkosCursorSessionToken value."
      );
    }
    printSuccess(
      `Imported ${imported.length} Cursor account${imported.length === 1 ? "" : "s"} from the desktop app: ${imported.join(", ")}`
    );
    return;
  }
  if (action === "accounts") {
    parseArgs(rest, {}, HELP_COMMAND);
    const accounts = await listCursorAccounts(paths);
    if (accounts.length === 0) {
      console.log("No Cursor accounts are saved.");
      console.log(dim(`Add one with: ${HELP_COMMAND} login`));
      return;
    }
    console.log(
      formatTable(
        accounts.map((account) => [
          account.isActive ? green("●") : " ",
          account.isActive ? bold(account.id) : account.id,
          account.label ? dim(account.label) : "",
        ])
      )
    );
    return;
  }
  if (action === "switch") {
    const [name] = parseArgs(rest, {}, HELP_COMMAND).positionals;
    const id = await setActiveCursorAccount(paths, requireAccount(name));
    printSuccess(`Switched to Cursor account ${bold(id)}`);
    return;
  }
  if (action === "logout") {
    const parsed = parseArgs(
      rest,
      { booleans: ["--purge-cache"] },
      HELP_COMMAND
    );
    const name = requireAccount(parsed.positionals[0]);
    await removeCursorAccount(
      paths,
      name,
      parsed.booleans.has("--purge-cache")
    );
    printSuccess(`Removed Cursor account ${bold(name)}`);
    return;
  }
  const parsed = parseArgs(rest, { booleans: ["--force"] }, HELP_COMMAND);
  const result = await syncCursorUsageCaches(paths, {
    force: parsed.booleans.has("--force"),
  });
  if (!result.synced && result.error) {
    throw new CliError(`Cursor sync failed: ${result.error}`);
  }
  if (result.synced) {
    printSuccess(
      `Synced Cursor usage (${result.rows} row${result.rows === 1 ? "" : "s"})`
    );
    return;
  }
  printInfo(
    `Cursor usage is already up to date. ${dim("Use --force to sync anyway.")}`
  );
};
