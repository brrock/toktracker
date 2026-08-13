import { z } from "zod";

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
  /** Present on newer clients so gateways can reject captured request replays. */
  requestId?: string;
  /** Unix time in milliseconds when this request was created. */
  sentAt?: number;
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

export const encryptPayload = async <Value>(
  value: Value,
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

const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const decryptPayload = async (
  value: EncryptedPayload,
  secret: string
): Promise<JsonValue> => {
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    {
      iv: base64ToBytes(value.initializationVector),
      name: "AES-GCM",
    },
    key,
    base64ToBytes(value.payload)
  );
  return jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(decrypted)));
};

const MAX_ENCRYPTED_PAYLOAD_LENGTH = 22 * 1024 * 1024;
const encryptedPayloadSchema = z.object({
  encrypted: z.literal(true),
  initializationVector: z.string().length(16),
  payload: z.string().max(MAX_ENCRYPTED_PAYLOAD_LENGTH),
});

export const isEncryptedPayload = <Value>(
  value: Value
): value is Value & EncryptedPayload =>
  encryptedPayloadSchema.safeParse(value).success;

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

export interface SessionUsagePart {
  model: string;
  provider: string;
  tokens: TokenBreakdown;
  cost: number;
  messages: number;
  startedAt: number;
  lastSeen: number;
}

export type SessionSort = "createdAt" | "lastSeen";

export interface SessionSummary {
  /** Stable opaque identity for the device/source/session tuple. */
  id: string;
  deviceId: string;
  sourcePath: string;
  sessionId: string;
  title?: string;
  /** Timestamp of the first usage recorded for this session. */
  createdAt: number;
  client: string;
  project: string;
  model: string;
  tokens: number;
  cost: number;
  lastSeen: number;
  /** Consecutive usage recorded with the same model. Present on session detail responses. */
  parts?: SessionUsagePart[];
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

const MAX_SESSIONS = 10_000;
const MAX_MESSAGES = 100_000;
const MAX_SOURCE_UPDATES = 10_000;
const MAX_SHORT_STRING_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;

const boundedStringSchema = (maximum: number) => z.string().min(1).max(maximum);
const optionalStringSchema = (maximum: number) => z.string().max(maximum);
const finiteNonNegativeSchema = z.number().finite().nonnegative();
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();

const tokenBreakdownSchema = z.object({
  cacheRead: finiteNonNegativeSchema,
  cacheWrite: finiteNonNegativeSchema,
  input: finiteNonNegativeSchema,
  output: finiteNonNegativeSchema,
  reasoning: finiteNonNegativeSchema,
});

const usageMessageSchema = z.object({
  agent: optionalStringSchema(MAX_SHORT_STRING_LENGTH).optional(),
  client: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
  cost: finiteNonNegativeSchema,
  costSource: z.enum(["unknown", "providerReported", "estimated"]),
  date: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
  dedupKey: optionalStringSchema(MAX_PATH_LENGTH).optional(),
  durationMs: finiteNonNegativeSchema.optional(),
  isTurnStart: z.boolean(),
  messageCount: safeNonNegativeIntegerSchema,
  modelId: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
  providerId: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
  sessionId: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
  sessionTitle: optionalStringSchema(MAX_PATH_LENGTH).optional(),
  timestamp: z.number().finite(),
  tokens: tokenBreakdownSchema,
  workspaceKey: optionalStringSchema(MAX_PATH_LENGTH).optional(),
  workspaceLabel: optionalStringSchema(MAX_PATH_LENGTH).optional(),
});

const sessionSnapshotSchema = z
  .object({
    deviceId: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
    messages: z.array(usageMessageSchema).min(1),
    project: optionalStringSchema(MAX_PATH_LENGTH).optional(),
    sessionId: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
    sourceMtimeMs: finiteNonNegativeSchema,
    sourcePath: boundedStringSchema(MAX_PATH_LENGTH),
    sourceSize: safeNonNegativeIntegerSchema,
  })
  .refine(
    ({ messages, sessionId }) =>
      messages.every((message) => message.sessionId === sessionId),
    { error: "Message session IDs must match their session" }
  );

const sourceUpdateSchema = z
  .object({
    mode: z.enum(["replace", "patch"]),
    removedSessionIds: z
      .array(boundedStringSchema(MAX_SHORT_STRING_LENGTH))
      .max(MAX_SESSIONS)
      .optional(),
    sourcePath: boundedStringSchema(MAX_PATH_LENGTH),
  })
  .refine(
    ({ mode, removedSessionIds }) =>
      removedSessionIds === undefined || mode === "patch",
    { error: "Only patch updates may remove sessions" }
  );

const ingestRequestSchema = z
  .object({
    device: z.object({
      id: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
      name: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
      platform: boundedStringSchema(MAX_SHORT_STRING_LENGTH),
    }),
    requestId: boundedStringSchema(MAX_SHORT_STRING_LENGTH).optional(),
    sentAt: z.number().int().safe().positive().optional(),
    sessions: z.array(sessionSnapshotSchema).max(MAX_SESSIONS),
    sourceUpdates: z
      .array(sourceUpdateSchema)
      .max(MAX_SOURCE_UPDATES)
      .optional(),
  })
  .refine(
    ({ requestId, sentAt }) =>
      (requestId === undefined) === (sentAt === undefined),
    { error: "Request ID and timestamp must be supplied together" }
  )
  .refine(
    ({ device, sessions }) =>
      sessions.every((session) => session.deviceId === device.id),
    { error: "Session device IDs must match the request device" }
  )
  .refine(
    ({ sessions }) =>
      sessions.reduce((count, session) => count + session.messages.length, 0) <=
      MAX_MESSAGES,
    { error: "Request contains too many messages" }
  );

export const isIngestRequest = <Value>(
  value: Value
): value is Value & IngestRequest =>
  ingestRequestSchema.safeParse(value).success;
