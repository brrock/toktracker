import { Database } from "bun:sqlite";

import { readConfig } from "./runtime-config";
import {
  bold,
  CliError,
  didYouMean,
  dim,
  formatTable,
  printSuccess,
  usageError,
} from "./ui";

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const AUTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dashboard_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS dashboard_pairing_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS dashboard_tokens (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(device_id) REFERENCES dashboard_devices(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS dashboard_tokens_device ON dashboard_tokens(device_id);
`;

const hashSecret = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
const normalizePairingCode = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9]/gu, "").toUpperCase();
const generatePairingCode = (): string =>
  normalizePairingCode(crypto.randomUUID())
    .slice(0, 16)
    .match(/.{1,4}/gu)
    ?.join("-") ?? crypto.randomUUID();

const openAuthDatabase = async (): Promise<Database> => {
  const config = await readConfig("gateway");
  const databasePath = process.env.TOKTRACKER_DB ?? config.TOKTRACKER_DB;
  if (!databasePath) {
    throw new CliError(
      "The gateway database is not configured",
      `Run ${bold("toktracker-gateway setup")} first.`
    );
  }
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec(AUTH_SCHEMA);
  return database;
};

const createCode = (database: Database): void => {
  const now = Date.now();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  const code = generatePairingCode();
  database
    .query("DELETE FROM dashboard_pairing_codes WHERE expires_at<=?")
    .run(now);
  database
    .query(
      "INSERT INTO dashboard_pairing_codes(code_hash,created_at,expires_at) VALUES(?,?,?)"
    )
    .run(hashSecret(normalizePairingCode(code)), now, expiresAt);
  const minutes = Math.round(PAIRING_CODE_TTL_MS / 60_000);
  console.log(`\n  ${bold(code)}\n`);
  console.log(
    `Enter this code in the dashboard to pair a browser. ${dim(`It expires in ${minutes} minutes (${new Date(expiresAt).toLocaleTimeString()}) and works once.`)}`
  );
};

const listDevices = (database: Database): void => {
  const devices = database
    .query<
      { createdAt: number; id: string; lastSeen: number; name: string },
      []
    >(
      "SELECT id,name,created_at as createdAt,last_seen as lastSeen FROM dashboard_devices ORDER BY last_seen DESC"
    )
    .all();
  if (devices.length === 0) {
    console.log("No browsers are paired with the dashboard yet.");
    console.log(
      dim(`Create a pairing code with: ${bold("toktracker-gateway auth code")}`)
    );
    return;
  }
  const rows = [
    [bold("ID"), bold("Name"), bold("Paired"), bold("Last seen")],
    ...devices.map((device) => [
      device.id,
      device.name,
      new Date(device.createdAt).toLocaleDateString(),
      new Date(device.lastSeen).toLocaleString(),
    ]),
  ];
  console.log(formatTable(rows));
  console.log(
    dim("\nSign a browser out with: toktracker-gateway auth revoke <id>")
  );
};

const revokeDevice = (
  database: Database,
  deviceId: string | undefined
): void => {
  if (!deviceId) {
    throw usageError(
      "A device ID is required",
      `Find it with ${bold("toktracker-gateway auth devices")}.`
    );
  }
  const result = database
    .query("DELETE FROM dashboard_devices WHERE id=?")
    .run(deviceId);
  if (result.changes === 0) {
    throw new CliError(
      `No paired browser has ID ${deviceId}`,
      `List paired browsers with ${bold("toktracker-gateway auth devices")}.`
    );
  }
  printSuccess(`Signed out browser ${bold(deviceId)}`);
};

export const runDashboardAuthCommand = async (
  args: string[]
): Promise<void> => {
  const [action = "devices", deviceId] = args;
  const actions = ["code", "devices", "list", "pair", "revoke", "sign-out"];
  if (!actions.includes(action)) {
    throw usageError(
      `Unknown auth action "${action}"`,
      didYouMean(action, ["code", "devices", "revoke"]) ??
        "Run toktracker-gateway auth --help for usage."
    );
  }
  const database = await openAuthDatabase();
  try {
    if (action === "code" || action === "pair") {
      createCode(database);
      return;
    }
    if (action === "devices" || action === "list") {
      listDevices(database);
      return;
    }
    revokeDevice(database, deviceId);
  } finally {
    database.close();
  }
};
