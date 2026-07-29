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

const MAX_ENCRYPTED_PAYLOAD_LENGTH = 22 * 1024 * 1024;
export const isEncryptedPayload = (value: unknown): value is EncryptedPayload =>
  Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<EncryptedPayload>).encrypted === true &&
    typeof (value as Partial<EncryptedPayload>).initializationVector ===
      "string" &&
    (value as Partial<EncryptedPayload>).initializationVector?.length === 16 &&
    typeof (value as Partial<EncryptedPayload>).payload === "string" &&
    ((value as Partial<EncryptedPayload>).payload?.length ?? 0) <=
      MAX_ENCRYPTED_PAYLOAD_LENGTH
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
  /** Stable opaque identity for the device/source/session tuple. */
  id: string;
  deviceId: string;
  sourcePath: string;
  sessionId: string;
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

const MAX_SESSIONS = 10_000;
const MAX_MESSAGES = 100_000;
const MAX_SOURCE_UPDATES = 10_000;
const MAX_SHORT_STRING_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const isOptionalString = (value: unknown, maximum: number): boolean =>
  value === undefined || (typeof value === "string" && value.length <= maximum);
const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isTokenBreakdown = (value: unknown): value is TokenBreakdown =>
  isRecord(value) &&
  isFiniteNonNegative(value.input) &&
  isFiniteNonNegative(value.output) &&
  isFiniteNonNegative(value.cacheRead) &&
  isFiniteNonNegative(value.cacheWrite) &&
  isFiniteNonNegative(value.reasoning);

const hasValidMessageStrings = (
  value: Record<string, unknown>,
  expectedSessionId: string
): boolean =>
  isBoundedString(value.client, MAX_SHORT_STRING_LENGTH) &&
  isBoundedString(value.modelId, MAX_SHORT_STRING_LENGTH) &&
  isBoundedString(value.providerId, MAX_SHORT_STRING_LENGTH) &&
  value.sessionId === expectedSessionId &&
  isOptionalString(value.workspaceKey, MAX_PATH_LENGTH) &&
  isOptionalString(value.workspaceLabel, MAX_PATH_LENGTH) &&
  isBoundedString(value.date, MAX_SHORT_STRING_LENGTH) &&
  isOptionalString(value.agent, MAX_SHORT_STRING_LENGTH) &&
  isOptionalString(value.dedupKey, MAX_PATH_LENGTH) &&
  isOptionalString(value.sessionTitle, MAX_PATH_LENGTH);

const hasValidMessageUsage = (value: Record<string, unknown>): boolean =>
  isFiniteNumber(value.timestamp) &&
  isTokenBreakdown(value.tokens) &&
  isFiniteNonNegative(value.cost) &&
  (value.costSource === "unknown" ||
    value.costSource === "providerReported" ||
    value.costSource === "estimated") &&
  (value.durationMs === undefined || isFiniteNonNegative(value.durationMs)) &&
  isFiniteNonNegative(value.messageCount) &&
  Number.isSafeInteger(value.messageCount) &&
  typeof value.isTurnStart === "boolean";

const isUsageMessage = (
  value: unknown,
  expectedSessionId: string
): value is UsageMessage =>
  isRecord(value) &&
  hasValidMessageStrings(value, expectedSessionId) &&
  hasValidMessageUsage(value);

const isSourceUpdate = (value: unknown): value is SourceUpdate => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isBoundedString(value.sourcePath, MAX_PATH_LENGTH) ||
    (value.mode !== "replace" && value.mode !== "patch")
  ) {
    return false;
  }
  if (value.removedSessionIds === undefined) {
    return true;
  }
  return (
    value.mode === "patch" &&
    Array.isArray(value.removedSessionIds) &&
    value.removedSessionIds.length <= MAX_SESSIONS &&
    value.removedSessionIds.every((sessionId) =>
      isBoundedString(sessionId, MAX_SHORT_STRING_LENGTH)
    )
  );
};

const isDevice = (value: unknown): value is IngestRequest["device"] =>
  isRecord(value) &&
  isBoundedString(value.id, MAX_SHORT_STRING_LENGTH) &&
  isBoundedString(value.name, MAX_SHORT_STRING_LENGTH) &&
  isBoundedString(value.platform, MAX_SHORT_STRING_LENGTH);

const isSessionSnapshot = (
  value: unknown,
  expectedDeviceId: string
): value is SessionSnapshot =>
  isRecord(value) &&
  value.deviceId === expectedDeviceId &&
  isBoundedString(value.sourcePath, MAX_PATH_LENGTH) &&
  isFiniteNonNegative(value.sourceMtimeMs) &&
  isFiniteNonNegative(value.sourceSize) &&
  Number.isSafeInteger(value.sourceSize) &&
  isBoundedString(value.sessionId, MAX_SHORT_STRING_LENGTH) &&
  isOptionalString(value.project, MAX_PATH_LENGTH) &&
  Array.isArray(value.messages) &&
  value.messages.length > 0 &&
  value.messages.every((message) =>
    isUsageMessage(message, value.sessionId as string)
  );

const hasValidSourceUpdates = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= MAX_SOURCE_UPDATES &&
    value.every(isSourceUpdate));

export const isIngestRequest = (value: unknown): value is IngestRequest => {
  if (!isRecord(value) || !isDevice(value.device)) {
    return false;
  }
  const { device, sessions, sourceUpdates } = value;
  if (
    !Array.isArray(sessions) ||
    sessions.length > MAX_SESSIONS ||
    !hasValidSourceUpdates(sourceUpdates) ||
    !sessions.every((session) => isSessionSnapshot(session, device.id))
  ) {
    return false;
  }
  const messageCount = sessions.reduce(
    (count, session) => count + (session as SessionSnapshot).messages.length,
    0
  );
  return messageCount <= MAX_MESSAGES;
};
