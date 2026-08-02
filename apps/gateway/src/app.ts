/* eslint-disable node/callback-return -- Hono next() is a promise continuation, not a Node callback. */
import { timingSafeEqual } from "node:crypto";

import {
  decryptPayload,
  isEncryptedPayload,
  isIngestRequest,
} from "@toktracker/shared";
import type { TimeRange } from "@toktracker/shared";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";

import type { DashboardCredentials, Store } from "./store";

const TIME_RANGES = new Set<TimeRange>(["day", "week", "month", "year", "all"]);
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PAIRING_BODY_BYTES = 4096;
const MAX_FILTER_VALUES = 100;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;
const ACCESS_COOKIE = "toktracker_access";
const REFRESH_COOKIE = "toktracker_refresh";
const ACCESS_COOKIE_SECONDS = 15 * 60;
const REFRESH_COOKIE_SECONDS = 30 * 24 * 60 * 60;
const PUBLIC_AUTH_PATHS = new Set([
  "/api/v1/auth/pair",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
]);

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
      context.req.path === "/api/v1/ingest";
    if (isClientRoute) {
      if (accessKey && !hasSharedKey) {
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
    let body: unknown = null;
    try {
      body = JSON.parse(submittedText) as unknown;
    } catch {
      return context.json({ error: "Invalid pairing request" }, 400);
    }
    if (!body || typeof body !== "object") {
      return context.json({ error: "Invalid pairing request" }, 400);
    }
    const request = body as { code?: unknown; deviceName?: unknown };
    if (
      typeof request.code !== "string" ||
      request.code.length > 64 ||
      typeof request.deviceName !== "string" ||
      request.deviceName.trim().length === 0 ||
      request.deviceName.length > 128
    ) {
      return context.json({ error: "Invalid pairing request" }, 400);
    }
    const credentials = store.pairDashboardDevice(
      request.code,
      request.deviceName.trim()
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
  app.post("/api/v1/ingest", async (context) => {
    const contentLength = Number(context.req.header("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return context.json({ error: "Ingestion payload is too large" }, 413);
    }
    const submittedText = await context.req.text();
    if (new TextEncoder().encode(submittedText).byteLength > MAX_BODY_BYTES) {
      return context.json({ error: "Ingestion payload is too large" }, 413);
    }
    let submittedBody: unknown = null;
    try {
      submittedBody = JSON.parse(submittedText) as unknown;
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
    return result.banned
      ? context.json({ error: "This device has been banned" }, 403)
      : context.json(result);
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
    const requestedRange = context.req.query("range") as TimeRange | undefined;
    const range =
      requestedRange && TIME_RANGES.has(requestedRange)
        ? requestedRange
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

  const dashboardDir =
    process.env.TOKTRACKER_DASHBOARD_DIR ??
    new URL("dashboard/", import.meta.url).pathname;
  app.get("*", async (context) => {
    const requested =
      context.req.path === "/" ? "index.html" : context.req.path.slice(1);
    const candidate = Bun.file(`${dashboardDir}/${requested}`);
    const file = (await candidate.exists())
      ? candidate
      : Bun.file(`${dashboardDir}/index.html`);
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
