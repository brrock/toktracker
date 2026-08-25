/* eslint-disable node/callback-return -- Hono next() is a promise continuation, not a Node callback. */
import { timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  decryptPayload,
  isEncryptedPayload,
  isIngestRequest,
} from "@toktracker/shared";
import type { TimeRange } from "@toktracker/shared";
import { clampCursorSyncIntervalMs } from "@toktracker/token-calc";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

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
const jsonValueSchema = z.json();
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
const timeRangeSchema = z.enum(["day", "week", "month", "year", "all"]);

const validAccessKey = (
  expectedKey: string | undefined,
  authorization: string | undefined
): boolean => {
  if (!expectedKey) {
    return false;
  }
  const submittedKey = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expected = Buffer.from(expectedKey);
  const submitted = Buffer.from(submittedKey);
  return (
    expected.length === submitted.length && timingSafeEqual(expected, submitted)
  );
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
  app.use(
    "*",
    secureHeaders({
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
      permissionsPolicy: {
        camera: [],
        geolocation: [],
        microphone: [],
      },
      xFrameOptions: "DENY",
    })
  );
  const allowedOrigin = process.env.TOKTRACKER_CORS_ORIGIN;
  if (allowedOrigin) {
    app.use("/api/*", cors({ origin: allowedOrigin }));
  }
  app.use("/api/*", async (context, next) => {
    if (PUBLIC_AUTH_PATHS.has(context.req.path)) {
      return next();
    }
    const hasSharedKey = validAccessKey(
      accessKey,
      context.req.header("authorization")
    );
    const accessToken = getCookie(context, ACCESS_COOKIE);
    const hasDashboardSession = Boolean(
      accessToken && store.authenticateDashboard(accessToken)
    );
    const isClientRoute =
      context.req.path === "/api/health" ||
      context.req.path === "/api/v1/ingest" ||
      context.req.path === "/api/v1/client-update-policy" ||
      context.req.path === "/api/v1/client-cursor-policy" ||
      context.req.path === "/api/v1/client-cursor-status" ||
      context.req.path === "/api/v1/client-cursor-commands/ack";
    if (isClientRoute) {
      const encryptedIngestCanAuthenticateItself =
        context.req.path === "/api/v1/ingest";
      if (accessKey && !hasSharedKey && !encryptedIngestCanAuthenticateItself) {
        return context.json(
          { error: "A valid ingestion key is required" },
          401
        );
      }
      await next();
      return;
    }
    if (dashboardAuthRequired && !hasDashboardSession) {
      return context.json({ error: "Dashboard pairing is required" }, 401);
    }
    await next();
  });
  app.post("/api/v1/auth/pair", async (context) => {
    const submittedText = await context.req.text();
    if (
      new TextEncoder().encode(submittedText).byteLength >
      MAX_PAIRING_BODY_BYTES
    ) {
      return context.json({ error: "Pairing request is too large" }, 413);
    }
    let request: z.infer<typeof pairingRequestSchema>;
    try {
      request = pairingRequestSchema.parse(JSON.parse(submittedText));
    } catch {
      return context.json({ error: "Invalid pairing request" }, 400);
    }
    const credentials = store.pairDashboardDevice(
      request.code,
      request.deviceName
    );
    if (!credentials) {
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
    context.json(store.cursorDashboardOverview())
  );
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
      store.setCursorDashboardSettings({
        cloudAgentApiKey: settings.cloudAgentApiKey,
        enabled: settings.enabled,
        includeAutomations: settings.includeAutomations ?? false,
        includeCloudAgents: settings.includeCloudAgents ?? true,
        syncIntervalMs: clampCursorSyncIntervalMs(settings.syncIntervalMs),
        t3Home: settings.t3Home,
        useT3CodeLocalSessions: settings.useT3CodeLocalSessions ?? false,
      })
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
    const contentLength = Number(context.req.header("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return context.json({ error: "Ingestion payload is too large" }, 413);
    }
    const submittedText = await context.req.text();
    if (new TextEncoder().encode(submittedText).byteLength > MAX_BODY_BYTES) {
      return context.json({ error: "Ingestion payload is too large" }, 413);
    }
    let submittedBody: z.infer<typeof jsonValueSchema>;
    try {
      submittedBody = jsonValueSchema.parse(JSON.parse(submittedText));
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
    if (!isIngestRequest(body)) {
      return context.json({ error: "Invalid ingestion payload" }, 400);
    }
    const result = store.ingest(body);
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
  app.get("/api/v1/sessions/search", (context) => {
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
      store.sessions(
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
  app.get("/api/v1/summary", (context) => {
    const devices = queryList(context.req.query("devices"));
    const requestedRange = timeRangeSchema.safeParse(
      context.req.query("range")
    );
    const range: TimeRange = requestedRange.success
      ? requestedRange.data
      : "month";
    const includeAllDevices = context.req.query("includeAllDevices") === "true";
    return context.json(
      store.summary(
        devices,
        range,
        includeAllDevices,
        context.req.query("sessionSort") === "createdAt"
          ? "createdAt"
          : "lastSeen"
      )
    );
  });

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
    const file = (await candidate.exists())
      ? candidate
      : Bun.file(dashboardIndex);
    if (!(await file.exists())) {
      return context.text(
        "Dashboard not built. Run `bun run build:dashboard`.",
        503
      );
    }
    return new Response(file);
  });
  return app;
};
