/* eslint-disable node/callback-return -- Hono next() is a promise continuation, not a Node callback. */
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  decryptPayload,
  isEncryptedPayload,
  parseIngestRequest,
} from "@toktracker/shared";
import type { JsonValue, TimeRange } from "@toktracker/shared";
import { clampCursorSyncIntervalMs } from "@toktracker/token-calc";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import { syncCloudAgentAccount } from "./cursor-cloud-agents";
import type {
  ClientAutoUpdateSettings,
  CursorDeviceStatus,
  DashboardCredentials,
  Store,
} from "./store";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const cursorDebug = (...details: unknown[]): void => {
  if (process.env.TOKTRACKER_DEV === "1") {
    console.info("[TokTracker Cursor gateway]", ...details);
  }
};
const MAX_PAIRING_BODY_BYTES = 4096;
const MAX_API_BODY_BYTES = 64 * 1024;
const PAIRING_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_FAILURES = 20;
// Sandboxed dashboard worker scripts; see the sandbox policy in createApp.
const SANDBOX_PATH_PREFIX = "/sandbox/";
const SECURE_PERMISSIONS_POLICY = {
  camera: [],
  geolocation: [],
  microphone: [],
};
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/iu;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "[::1]", "::1"]);
const CLIENT_ROUTES = new Set([
  "/api/health",
  "/api/v1/ingest",
  "/api/v1/client-update-policy",
  "/api/v1/client-cursor-policy",
  "/api/v1/client-cursor-status",
  "/api/v1/client-cursor-commands/ack",
  "/api/v1/client-provider-policy",
]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_FILTER_VALUES = 100;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;
const UPDATE_HOURS = new Set(Array.from({ length: 24 }, (_, hour) => hour));
const ACCESS_COOKIE = "toktracker_access";
const REFRESH_COOKIE = "toktracker_refresh";
const ACCESS_COOKIE_SECONDS = 15 * 60;
const REFRESH_COOKIE_SECONDS = 30 * 24 * 60 * 60;
const PUBLIC_AUTH_PATHS = new Set([
  "/api/v1/auth/pair",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
]);
const pairingRequestSchema = z.object({
  code: z.string().max(64),
  deviceName: z.string().trim().min(1).max(128),
});
const clientAutoUpdateSettingsSchema = z.object({
  channel: z.enum(["stable", "nightly"]),
  enabled: z.boolean(),
  windowEndHour: z.number().int().min(0).max(23),
  windowStartHour: z.number().int().min(0).max(23),
});
const cursorDashboardSettingsSchema = z.object({
  cloudAgentApiKey: z.string().max(512).optional(),
  enabled: z.boolean(),
  includeAutomations: z.boolean().optional(),
  includeCloudAgents: z.boolean().optional(),
  syncIntervalMs: z.number().finite().positive(),
  t3Home: z.string().max(1024).optional(),
  useT3CodeLocalSessions: z.boolean().optional(),
});
const copilotDashboardSettingsSchema = z.object({
  enabled: z.boolean(),
  importDesktop: z.boolean(),
  importOtel: z.boolean(),
  importVsCode: z.boolean(),
  otelExporterFile: z.string().max(1024).optional(),
});
const providerDashboardSettingsSchema = z.object({
  copilot: copilotDashboardSettingsSchema,
  cursor: cursorDashboardSettingsSchema,
});
const cursorDeviceStatusSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(128),
        isActive: z.boolean(),
        label: z.string().trim().max(128).optional(),
      })
    )
    .max(50),
  desktopEmail: z.string().trim().max(320).optional(),
  desktopSignedIn: z.boolean(),
  deviceId: z.string().trim().min(1).max(128),
  lastError: z.string().trim().max(1024).optional(),
  lastSyncAt: z.number().int().safe().nonnegative().optional(),
  syncIntervalMs: z.number().finite().positive(),
});
const cursorCommandAckSchema = z.object({
  commandIds: z.array(z.string().trim().min(1).max(128)).max(100),
  deviceId: z.string().trim().min(1).max(128),
});
const cursorAccountActionSchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
  cloudAgentApiKey: z.string().trim().min(1).max(512).optional(),
  deviceId: z.string().trim().min(1).max(128),
  label: z.string().trim().max(128).optional(),
  token: z.string().trim().min(1).max(8192).optional(),
});
const cloudAgentAccountRequestSchema = z.object({
  apiKey: z.string().trim().min(1).max(512),
  label: z.string().trim().min(1).max(128),
});
const timeRangeSchema = z.enum(["day", "week", "month", "year", "all"]);

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

// Comparing fixed-length digests keeps the check constant-time without
// revealing the configured key's length through an early length mismatch.
const validAccessKey = (
  expectedDigest: Buffer | undefined,
  authorization: string | undefined
): boolean => {
  if (!expectedDigest || !authorization?.startsWith("Bearer ")) {
    return false;
  }
  return timingSafeEqual(
    expectedDigest,
    sha256(authorization.slice("Bearer ".length))
  );
};

const isLoopbackHost = (hostHeader: string | undefined): boolean => {
  if (!hostHeader) {
    return false;
  }
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${hostHeader}`));
  } catch {
    return false;
  }
  return (
    LOOPBACK_HOSTNAMES.has(hostname) || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
};

const hasRequestBody = (
  headers: (name: string) => string | undefined
): boolean => {
  const contentLength = headers("content-length");
  return (
    Boolean(headers("transfer-encoding")) ||
    (contentLength !== undefined && contentLength !== "0")
  );
};

const redactCursorSettings = <Settings extends { cloudAgentApiKey?: string }>(
  settings: Settings
): Omit<Settings, "cloudAgentApiKey"> & {
  cloudAgentApiKeyConfigured: boolean;
} => {
  const { cloudAgentApiKey, ...rest } = settings;
  return { ...rest, cloudAgentApiKeyConfigured: Boolean(cloudAgentApiKey) };
};

const createPairingLimiter = () => {
  let failures: number[] = [];
  const prune = (now: number): void => {
    failures = failures.filter(
      (timestamp) => now - timestamp < PAIRING_FAILURE_WINDOW_MS
    );
  };
  return {
    blocked: (now: number): boolean => {
      prune(now);
      return failures.length >= MAX_PAIRING_FAILURES;
    },
    fail: (now: number): void => {
      failures.push(now);
    },
  };
};

const setDashboardCookies = (
  context: Parameters<typeof setCookie>[0],
  credentials: DashboardCredentials
): void => {
  const secure =
    context.req.url.startsWith("https://") ||
    context.req.header("x-forwarded-proto") === "https";
  setCookie(context, ACCESS_COOKIE, credentials.accessToken, {
    expires: new Date(credentials.accessTokenExpiresAt),
    httpOnly: true,
    maxAge: ACCESS_COOKIE_SECONDS,
    path: "/api",
    sameSite: "Strict",
    secure,
  });
  setCookie(context, REFRESH_COOKIE, credentials.refreshToken, {
    expires: new Date(credentials.refreshTokenExpiresAt),
    httpOnly: true,
    maxAge: REFRESH_COOKIE_SECONDS,
    path: "/api/v1/auth",
    sameSite: "Strict",
    secure,
  });
};

const clearDashboardCookies = (
  context: Parameters<typeof deleteCookie>[0]
): void => {
  deleteCookie(context, ACCESS_COOKIE, { path: "/api" });
  deleteCookie(context, REFRESH_COOKIE, { path: "/api/v1/auth" });
};

const queryList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .filter((item) => item.length > 0 && item.length <= 512)
    .slice(0, MAX_FILTER_VALUES);

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  maximum: number
): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
};

export const createApp = (
  store: Store,
  accessKey = process.env.TOKTRACKER_API_KEY,
  dashboardAuthRequired = true
): Hono => {
  const app = new Hono();
  const accessKeyDigest = accessKey ? sha256(accessKey) : undefined;
  const pairingLimiter = createPairingLimiter();
  const payloadTooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) =>
      context.json({ error: "Ingestion payload is too large" }, 413),
  });
  const pairingTooLarge = bodyLimit({
    maxSize: MAX_PAIRING_BODY_BYTES,
    onError: (context) =>
      context.json({ error: "Pairing request is too large" }, 413),
  });
  const apiBodyTooLarge = bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (context) => context.json({ error: "Request is too large" }, 413),
  });
  // Summary JSON and the dashboard bundle compress roughly 5x.
  app.use("*", compress());
  const pageHeaders = secureHeaders({
    contentSecurityPolicy: {
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      defaultSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
    permissionsPolicy: SECURE_PERMISSIONS_POLICY,
    xFrameOptions: "DENY",
  });
  // Dashboard query widgets run user-written code in a dedicated worker
  // loaded from /sandbox/. A worker takes its CSP from its own script
  // response, so this policy lets that worker evaluate code and compile
  // SQLite's WebAssembly while forbidding every network request (so it
  // cannot use the dashboard session) and every other resource. The main
  // page keeps the strict policy above.
  const sandboxHeaders = secureHeaders({
    contentSecurityPolicy: {
      baseUri: ["'none'"],
      connectSrc: ["'none'"],
      defaultSrc: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"],
      workerSrc: ["'none'"],
    },
    permissionsPolicy: SECURE_PERMISSIONS_POLICY,
    xFrameOptions: "DENY",
  });
  app.use("*", (context, next) =>
    context.req.path.startsWith(SANDBOX_PATH_PREFIX)
      ? sandboxHeaders(context, next)
      : pageHeaders(context, next)
  );
  const allowedOrigin = process.env.TOKTRACKER_CORS_ORIGIN;
  if (allowedOrigin) {
    app.use("/api/*", cors({ origin: allowedOrigin }));
  }
  app.use("/api/*", async (context, next) => {
    // Without a shared key the gateway only listens on loopback. Rejecting
    // other Host names blocks DNS-rebinding pages from reading the
    // unauthenticated client routes (which include provider credentials).
    const host = context.req.header("host") ?? new URL(context.req.url).host;
    if (!accessKey && !isLoopbackHost(host)) {
      return context.json({ error: "Host is not allowed" }, 403);
    }
    // Cross-site pages can only send form or text bodies without a CORS
    // preflight. Requiring JSON for requests with a body blocks CSRF writes.
    if (
      !SAFE_METHODS.has(context.req.method) &&
      hasRequestBody((name) => context.req.header(name)) &&
      !JSON_CONTENT_TYPE.test(context.req.header("content-type") ?? "")
    ) {
      return context.json({ error: "Requests must be JSON" }, 415);
    }
    if (context.req.path === "/api/v1/ingest") {
      return await payloadTooLarge(context, next);
    }
    if (context.req.path === "/api/v1/auth/pair") {
      return await pairingTooLarge(context, next);
    }
    return await apiBodyTooLarge(context, next);
  });
  app.use("/api/*", async (context, next) => {
    if (PUBLIC_AUTH_PATHS.has(context.req.path)) {
      return next();
    }
    if (CLIENT_ROUTES.has(context.req.path)) {
      const encryptedIngestCanAuthenticateItself =
        context.req.path === "/api/v1/ingest";
      if (
        accessKey &&
        !encryptedIngestCanAuthenticateItself &&
        !validAccessKey(accessKeyDigest, context.req.header("authorization"))
      ) {
        return context.json(
          { error: "A valid ingestion key is required" },
          401
        );
      }
      await next();
      return;
    }
    if (!dashboardAuthRequired) {
      await next();
      return;
    }
    const accessToken = getCookie(context, ACCESS_COOKIE);
    if (!accessToken || !store.authenticateDashboard(accessToken)) {
      return context.json({ error: "Dashboard pairing is required" }, 401);
    }
    await next();
  });
  app.post("/api/v1/auth/pair", async (context) => {
    const now = Date.now();
    if (pairingLimiter.blocked(now)) {
      return context.json(
        { error: "Too many pairing attempts. Try again later." },
        429
      );
    }
    let request: z.infer<typeof pairingRequestSchema>;
    try {
      request = pairingRequestSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid pairing request" }, 400);
    }
    const credentials = store.pairDashboardDevice(
      request.code,
      request.deviceName
    );
    if (!credentials) {
      pairingLimiter.fail(now);
      return context.json({ error: "Pairing code is invalid or expired" }, 401);
    }
    setDashboardCookies(context, credentials);
    return context.json({ ok: true });
  });
  app.post("/api/v1/auth/refresh", (context) => {
    const refreshToken = getCookie(context, REFRESH_COOKIE);
    const credentials = refreshToken
      ? store.refreshDashboard(refreshToken)
      : undefined;
    if (!credentials) {
      clearDashboardCookies(context);
      return context.json({ error: "Dashboard session has expired" }, 401);
    }
    setDashboardCookies(context, credentials);
    return context.json({ ok: true });
  });
  app.post("/api/v1/auth/logout", (context) => {
    const refreshToken = getCookie(context, REFRESH_COOKIE);
    if (refreshToken) {
      store.revokeDashboardSession(refreshToken);
    }
    clearDashboardCookies(context);
    return context.json({ ok: true });
  });
  app.get("/api/health", (context) =>
    context.json({
      keyRequired: Boolean(accessKey),
      ok: true,
      service: "toktracker-gateway",
    })
  );
  app.get("/api/v1/client-update-policy", (context) =>
    context.json(store.clientAutoUpdateSettings())
  );
  app.get("/api/v1/settings/client-auto-update", (context) =>
    context.json(store.clientAutoUpdateSettings())
  );
  app.put("/api/v1/settings/client-auto-update", async (context) => {
    let settings: ClientAutoUpdateSettings;
    try {
      settings = clientAutoUpdateSettingsSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid update settings" }, 400);
    }
    if (
      !UPDATE_HOURS.has(settings.windowStartHour) ||
      !UPDATE_HOURS.has(settings.windowEndHour) ||
      settings.windowStartHour === settings.windowEndHour
    ) {
      return context.json({ error: "Invalid update settings" }, 400);
    }
    return context.json(store.setClientAutoUpdateSettings(settings));
  });
  app.get("/api/v1/client-cursor-policy", (context) => {
    const deviceId = context.req.query("deviceId")?.trim() ?? "";
    const settings = store.cursorDashboardSettings();
    const commands = deviceId ? store.cursorCommandsForDevice(deviceId) : [];
    cursorDebug("policy requested", {
      apiKeyConfigured: Boolean(settings.cloudAgentApiKey),
      commandTypes: commands.map((command) => command.type),
      deviceId,
    });
    return context.json({
      cloudAgentApiKey: settings.cloudAgentApiKey,
      commands,
      enabled: settings.enabled,
      includeAutomations: settings.includeAutomations,
      includeCloudAgents: settings.includeCloudAgents,
      syncIntervalMs: settings.syncIntervalMs,
      t3Home: settings.t3Home,
      useT3CodeLocalSessions: settings.useT3CodeLocalSessions,
    });
  });
  app.get("/api/v1/client-provider-policy", (context) => {
    const deviceId = context.req.query("deviceId")?.trim() ?? "";
    const settings = store.providerDashboardSettings();
    return context.json({
      ...settings,
      commands: deviceId ? store.cursorCommandsForDevice(deviceId) : [],
    });
  });
  app.post("/api/v1/client-cursor-status", async (context) => {
    let status: CursorDeviceStatus;
    try {
      status = cursorDeviceStatusSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor status" }, 400);
    }
    cursorDebug("status received", {
      accounts: status.accounts.map((account) => account.id),
      desktopSignedIn: status.desktopSignedIn,
      deviceId: status.deviceId,
      lastError: status.lastError,
    });
    return context.json(store.recordCursorDeviceStatus(status));
  });
  app.post("/api/v1/client-cursor-commands/ack", async (context) => {
    let body: z.infer<typeof cursorCommandAckSchema>;
    try {
      body = cursorCommandAckSchema.parse(await context.req.json());
    } catch {
      return context.json(
        { error: "Invalid Cursor command acknowledgement" },
        400
      );
    }
    const removed = store.ackCursorCommands(body.deviceId, body.commandIds);
    cursorDebug("commands acknowledged", {
      commandCount: body.commandIds.length,
      deviceId: body.deviceId,
      removed,
    });
    return context.json({ removed });
  });
  app.get("/api/v1/settings/cursor", (context) =>
    context.json({
      ...redactCursorSettings(store.cursorDashboardOverview()),
      cloudAgentAccounts: store.cloudAgentAccountOverview(),
    })
  );
  app.get("/api/v1/settings/providers", (context) => {
    const settings = store.providerDashboardSettings();
    return context.json({
      cloudAgentAccounts: store.cloudAgentAccountOverview(),
      copilot: settings.copilot,
      cursor: redactCursorSettings(settings.cursor),
      devices: store.cursorDashboardOverview().devices,
    });
  });
  app.post("/api/v1/settings/cursor/cloud-agent-accounts", async (context) => {
    let body: z.infer<typeof cloudAgentAccountRequestSchema>;
    try {
      body = cloudAgentAccountRequestSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cloud Agent account" }, 400);
    }
    let account;
    try {
      account = store.addCloudAgentAccount(body.label, body.apiKey);
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error ? error.message : "Could not save account",
        },
        400
      );
    }
    const stored = store
      .cloudAgentAccounts()
      .find((candidate) => candidate.id === account.id);
    if (!stored) {
      return context.json({ error: "Could not load saved account" }, 500);
    }
    try {
      const agents = await syncCloudAgentAccount(store, stored);
      return context.json({ ...account, agents });
    } catch (error) {
      return context.json(
        {
          ...account,
          error:
            error instanceof Error ? error.message : "Cloud Agent sync failed",
        },
        502
      );
    }
  });
  app.post(
    "/api/v1/settings/cursor/cloud-agent-accounts/:id/sync",
    async (context) => {
      const account = store
        .cloudAgentAccounts()
        .find((candidate) => candidate.id === context.req.param("id"));
      if (!account) {
        return context.json({ error: "Cloud Agent account not found" }, 404);
      }
      try {
        const agents = await syncCloudAgentAccount(store, account);
        return context.json({ agents });
      } catch (error) {
        return context.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Cloud Agent sync failed",
          },
          502
        );
      }
    }
  );
  app.delete("/api/v1/settings/cursor/cloud-agent-accounts/:id", (context) =>
    store.removeCloudAgentAccount(context.req.param("id"))
      ? context.json({ ok: true })
      : context.json({ error: "Cloud Agent account not found" }, 404)
  );
  app.put("/api/v1/settings/providers", async (context) => {
    let settings: z.infer<typeof providerDashboardSettingsSchema>;
    try {
      settings = providerDashboardSettingsSchema.parse(
        await context.req.json()
      );
    } catch {
      return context.json({ error: "Invalid provider settings" }, 400);
    }
    const saved = store.setProviderDashboardSettings({
      copilot: settings.copilot,
      cursor: {
        cloudAgentApiKey: settings.cursor.cloudAgentApiKey,
        enabled: settings.cursor.enabled,
        includeAutomations: settings.cursor.includeAutomations ?? false,
        includeCloudAgents: settings.cursor.includeCloudAgents ?? true,
        syncIntervalMs: clampCursorSyncIntervalMs(
          settings.cursor.syncIntervalMs
        ),
        t3Home: settings.cursor.t3Home,
        useT3CodeLocalSessions: settings.cursor.useT3CodeLocalSessions ?? false,
      },
    });
    return context.json({
      copilot: saved.copilot,
      cursor: redactCursorSettings(saved.cursor),
    });
  });
  app.put("/api/v1/settings/cursor", async (context) => {
    let settings: z.infer<typeof cursorDashboardSettingsSchema>;
    try {
      settings = cursorDashboardSettingsSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor settings" }, 400);
    }
    cursorDebug("settings saved", {
      apiKeyConfigured: Boolean(settings.cloudAgentApiKey?.trim()),
      enabled: settings.enabled,
      syncIntervalMs: settings.syncIntervalMs,
    });
    return context.json(
      redactCursorSettings(
        store.setCursorDashboardSettings({
          cloudAgentApiKey: settings.cloudAgentApiKey,
          enabled: settings.enabled,
          includeAutomations: settings.includeAutomations ?? false,
          includeCloudAgents: settings.includeCloudAgents ?? true,
          syncIntervalMs: clampCursorSyncIntervalMs(settings.syncIntervalMs),
          t3Home: settings.t3Home,
          useT3CodeLocalSessions: settings.useT3CodeLocalSessions ?? false,
        })
      )
    );
  });
  app.post("/api/v1/settings/cursor/import-desktop", async (context) => {
    let body: z.infer<typeof cursorAccountActionSchema>;
    try {
      body = cursorAccountActionSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor account request" }, 400);
    }
    store.enqueueCursorCommand(body.deviceId, { type: "import-desktop" });
    cursorDebug("command queued", {
      deviceId: body.deviceId,
      type: "import-desktop",
    });
    return context.json({ ok: true });
  });
  app.post("/api/v1/settings/cursor/accounts", async (context) => {
    let body: z.infer<typeof cursorAccountActionSchema>;
    try {
      body = cursorAccountActionSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor account request" }, 400);
    }
    if (!body.token) {
      return context.json({ error: "A session token is required" }, 400);
    }
    store.enqueueCursorCommand(body.deviceId, {
      cloudAgentApiKey: body.cloudAgentApiKey,
      label: body.label,
      token: body.token,
      type: "add-account",
    });
    cursorDebug("command queued", {
      deviceId: body.deviceId,
      label: body.label,
      tokenLength: body.token.length,
      type: "add-account",
    });
    return context.json({ ok: true });
  });
  app.post("/api/v1/settings/cursor/accounts/api-key", async (context) => {
    let body: z.infer<typeof cursorAccountActionSchema>;
    try {
      body = cursorAccountActionSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor account request" }, 400);
    }
    if (!body.accountId || !body.cloudAgentApiKey) {
      return context.json(
        { error: "An account and API key are required" },
        400
      );
    }
    store.enqueueCursorCommand(body.deviceId, {
      accountId: body.accountId,
      cloudAgentApiKey: body.cloudAgentApiKey,
      type: "set-api-key",
    });
    return context.json({ ok: true });
  });
  app.post("/api/v1/settings/cursor/accounts/remove", async (context) => {
    let body: z.infer<typeof cursorAccountActionSchema>;
    try {
      body = cursorAccountActionSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor account request" }, 400);
    }
    if (!body.accountId) {
      return context.json({ error: "An account id is required" }, 400);
    }
    store.enqueueCursorCommand(body.deviceId, {
      accountId: body.accountId,
      type: "remove-account",
    });
    cursorDebug("command queued", {
      accountId: body.accountId,
      deviceId: body.deviceId,
      type: "remove-account",
    });
    return context.json({ ok: true });
  });
  app.post("/api/v1/settings/cursor/accounts/switch", async (context) => {
    let body: z.infer<typeof cursorAccountActionSchema>;
    try {
      body = cursorAccountActionSchema.parse(await context.req.json());
    } catch {
      return context.json({ error: "Invalid Cursor account request" }, 400);
    }
    if (!body.accountId) {
      return context.json({ error: "An account id is required" }, 400);
    }
    store.enqueueCursorCommand(body.deviceId, {
      accountId: body.accountId,
      type: "switch-account",
    });
    return context.json({ ok: true });
  });
  app.post("/api/v1/ingest", async (context) => {
    let submittedBody: JsonValue;
    try {
      // JSON.parse output is always a JSON value; re-validating the whole
      // (up to 16 MiB) tree with z.json() only burned CPU before the real
      // schema check below.
      submittedBody = await context.req.json<JsonValue>();
    } catch {
      return context.json({ error: "Invalid JSON payload" }, 400);
    }
    if (accessKey && !isEncryptedPayload(submittedBody)) {
      return context.json(
        { error: "An encrypted ingestion payload is required" },
        400
      );
    }
    let body = submittedBody;
    if (accessKey && isEncryptedPayload(submittedBody)) {
      try {
        body = await decryptPayload(submittedBody, accessKey);
      } catch {
        return context.json(
          { error: "Could not decrypt ingestion payload" },
          400
        );
      }
    }
    const ingestRequest = parseIngestRequest(body);
    if (!ingestRequest) {
      return context.json({ error: "Invalid ingestion payload" }, 400);
    }
    const result = store.ingest(ingestRequest);
    if (result.banned) {
      return context.json({ error: "This device has been banned" }, 403);
    }
    if (result.replayed) {
      return context.json(
        { error: "Ingestion request was already applied" },
        409
      );
    }
    if (result.expired) {
      return context.json({ error: "Ingestion request has expired" }, 400);
    }
    return context.json(result);
  });
  app.get("/api/v1/dashboard-devices", (context) =>
    context.json(store.dashboardDevices())
  );
  app.delete("/api/v1/dashboard-devices/:id", (context) =>
    store.revokeDashboardDevice(context.req.param("id"))
      ? context.json({ ok: true })
      : context.json({ error: "Dashboard device not found" }, 404)
  );
  app.delete("/api/v1/devices/:id", (context) =>
    store.banDevice(context.req.param("id"))
      ? context.json({ ok: true })
      : context.json({ error: "Usage device not found" }, 404)
  );
  app.get("/api/v1/sessions/search", async (context) => {
    const devices = queryList(context.req.query("devices"));
    const agents = queryList(context.req.query("agents"));
    const limit = boundedInteger(
      context.req.query("limit"),
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    );
    const offset = boundedInteger(
      context.req.query("offset"),
      0,
      Number.MAX_SAFE_INTEGER - MAX_PAGE_SIZE
    );
    return context.json(
      await store.sessionsAsync(
        context.req.query("q") ?? "",
        devices,
        agents,
        limit,
        offset,
        context.req.query("sort") === "createdAt" ? "createdAt" : "lastSeen"
      )
    );
  });
  app.get("/api/v1/sessions/:id", (context) => {
    const devices = queryList(context.req.query("devices"));
    const session = store.session(context.req.param("id"), devices);
    return session
      ? context.json(session)
      : context.json({ error: "Session not found" }, 404);
  });
  app.get("/api/v1/summary", async (context) => {
    const devices = queryList(context.req.query("devices"));
    const requestedRange = timeRangeSchema.safeParse(
      context.req.query("range")
    );
    const range: TimeRange = requestedRange.success
      ? requestedRange.data
      : "month";
    const includeAllDevices = context.req.query("includeAllDevices") === "true";
    return context.json(
      await store.summaryAsync(
        devices,
        range,
        includeAllDevices,
        context.req.query("sessionSort") === "createdAt"
          ? "createdAt"
          : "lastSeen"
      )
    );
  });
  app.all("/api/*", (context) => context.json({ error: "Not found" }, 404));

  const dashboardDir = path.resolve(
    process.env.TOKTRACKER_DASHBOARD_DIR ??
      new URL("dashboard/", import.meta.url).pathname
  );
  const dashboardPathPrefix = `${dashboardDir}${path.sep}`;
  const dashboardIndex = path.join(dashboardDir, "index.html");
  app.get("*", async (context) => {
    const requestedPath =
      context.req.path === "/"
        ? dashboardIndex
        : path.resolve(dashboardDir, `.${context.req.path}`);
    const candidatePath = requestedPath.startsWith(dashboardPathPrefix)
      ? requestedPath
      : dashboardIndex;
    const candidate = Bun.file(candidatePath);
    let candidateIsFile = false;
    if (candidatePath !== dashboardIndex && (await candidate.exists())) {
      const candidateStat = await candidate.stat();
      candidateIsFile = candidateStat.isFile();
    }
    // Never fall back to the app shell under /sandbox/: it would run with the
    // sandbox policy, which allows eval.
    if (!candidateIsFile && context.req.path.startsWith(SANDBOX_PATH_PREFIX)) {
      return context.text("Not found", 404);
    }
    const file = candidateIsFile ? candidate : Bun.file(dashboardIndex);
    if (!(await file.exists())) {
      return context.text(
        "Dashboard not built. Run `bun run build:dashboard`.",
        503
      );
    }
    // Vite fingerprints everything under assets/, so those files can be
    // cached forever; the HTML shell must be revalidated to pick up releases.
    const cacheControl =
      candidateIsFile &&
      (context.req.path.startsWith("/assets/") ||
        context.req.path.startsWith(SANDBOX_PATH_PREFIX))
        ? IMMUTABLE_ASSET_CACHE_CONTROL
        : "no-cache";
    return new Response(file, { headers: { "cache-control": cacheControl } });
  });
  return app;
};
