import { Database } from "bun:sqlite";

import { readConfig } from "./runtime-config";

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
    throw new Error("Gateway database is not configured. Run setup first.");
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
  console.log(`Dashboard pairing code: ${code}`);
  console.log(`Expires: ${new Date(expiresAt).toLocaleString()}`);
};

const listDevices = (database: Database): void => {
  const devices = database
    .query(
      "SELECT id,name,created_at as createdAt,last_seen as lastSeen FROM dashboard_devices ORDER BY last_seen DESC"
    )
    .all() as {
    id: string;
    name: string;
    createdAt: number;
    lastSeen: number;
  }[];
  if (devices.length === 0) {
    console.log("No paired dashboard devices.");
    return;
  }
  for (const device of devices) {
    console.log(
      `${device.id}\t${device.name}\tlast seen ${new Date(device.lastSeen).toLocaleString()}`
    );
  }
};

const revokeDevice = (
  database: Database,
  deviceId: string | undefined
): void => {
  if (!deviceId) {
    throw new Error("Usage: toktracker-gateway auth revoke <device-id>");
  }
  const result = database
    .query("DELETE FROM dashboard_devices WHERE id=?")
    .run(deviceId);
  if (result.changes === 0) {
    throw new Error(`No paired dashboard device has ID ${deviceId}`);
  }
  console.log(`Signed out dashboard device ${deviceId}`);
};

export const runDashboardAuthCommand = async (
  args: string[]
): Promise<void> => {
  const [action = "devices", deviceId] = args;
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
    if (action === "revoke" || action === "sign-out") {
      revokeDevice(database, deviceId);
      return;
    }
    throw new Error(
      "Usage: toktracker-gateway auth [code|devices|revoke <device-id>]"
    );
  } finally {
    database.close();
  }
};
