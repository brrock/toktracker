export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type CostSource = "unknown" | "providerReported" | "estimated";
export type TimeRange = "day" | "week" | "month" | "year" | "all";

export interface UsageMessage {
  client: string;
  modelId: string;
  providerId: string;
  sessionId: string;
  workspaceKey?: string;
  workspaceLabel?: string;
  timestamp: number;
  date: string;
  tokens: TokenBreakdown;
  cost: number;
  costSource: CostSource;
  durationMs?: number;
  messageCount: number;
  agent?: string;
  dedupKey?: string;
  sessionTitle?: string;
  isTurnStart: boolean;
}

export interface SessionSnapshot {
  deviceId: string;
  sourcePath: string;
  sourceMtimeMs: number;
  sourceSize: number;
  sessionId: string;
  project?: string;
  messages: UsageMessage[];
}

export interface SourceUpdate {
  sourcePath: string;
  /** Full replacement for JSON/JSONL; partial session patch for SQLite. */
  mode: "replace" | "patch";
  removedSessionIds?: string[];
}

export interface IngestRequest {
  device: { id: string; name: string; platform: string };
  sessions: SessionSnapshot[];
  sourceUpdates?: SourceUpdate[];
}

export interface EncryptedPayload {
  encrypted: true;
  initializationVector: string;
  payload: string;
}

const BASE64_CHUNK_SIZE = 32_768;
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCodePoint(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE)
    );
  }
  return btoa(binary);
};
const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  let index = 0;
  for (const character of binary) {
    bytes[index] = character.codePointAt(0) ?? 0;
    index += 1;
  }
  return bytes;
};

const encryptionKey = async (secret: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "decrypt",
    "encrypt",
  ]);
};

export const encryptPayload = async (
  value: unknown,
  secret: string
): Promise<EncryptedPayload> => {
  const initializationVector = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { iv: initializationVector, name: "AES-GCM" },
    key,
    plaintext
  );
  return {
    encrypted: true,
    initializationVector: bytesToBase64(initializationVector),
    payload: bytesToBase64(new Uint8Array(encrypted)),
  };
};

export const decryptPayload = async (
  value: EncryptedPayload,
  secret: string
): Promise<unknown> => {
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    {
      iv: base64ToBytes(value.initializationVector),
      name: "AES-GCM",
    },
    key,
    base64ToBytes(value.payload)
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
};

export const isEncryptedPayload = (value: unknown): value is EncryptedPayload =>
  Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<EncryptedPayload>).encrypted === true &&
    typeof (value as Partial<EncryptedPayload>).initializationVector ===
      "string" &&
    typeof (value as Partial<EncryptedPayload>).payload === "string"
  );

export interface TimeSeriesPoint {
  date: string;
  tokens: number;
  cost: number;
}

export interface UsageDetail {
  daily: TimeSeriesPoint[];
  agents: { name: string; tokens: number; cost: number }[];
  models: { name: string; tokens: number; cost: number }[];
  projects: {
    name: string;
    tokens: number;
    cost: number;
    sessions: number;
    lastSeen: number;
  }[];
}

export interface SessionSummary {
  id: string;
  title?: string;
  client: string;
  project: string;
  model: string;
  tokens: number;
  cost: number;
  lastSeen: number;
}

export interface DashboardSummary {
  totals: {
    tokens: number;
    cost: number;
    reportedCost: number;
    estimatedCost: number;
    unpricedTokens: number;
    messages: number;
    sessions: number;
  };
  devices: {
    id: string;
    name: string;
    platform: string;
    lastSeen: number;
  }[];
  daily: TimeSeriesPoint[];
  hourly: TimeSeriesPoint[];
  agents: { name: string; tokens: number; cost: number }[];
  agentDetails: Record<string, UsageDetail>;
  models: { name: string; tokens: number; cost: number }[];
  /** Optional for compatibility with gateways released before model details. */
  modelDetails?: Record<string, UsageDetail>;
  projects: {
    name: string;
    tokens: number;
    cost: number;
    sessions: number;
    lastSeen: number;
  }[];
  projectDetails: Record<string, UsageDetail>;
  recentSessions: SessionSummary[];
}

export const isIngestRequest = (value: unknown): value is IngestRequest => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<IngestRequest>;
  return (
    !!v.device &&
    typeof v.device.id === "string" &&
    typeof v.device.name === "string" &&
    Array.isArray(v.sessions)
  );
};
