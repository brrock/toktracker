import {
  decryptPayload,
  isEncryptedPayload,
  isIngestRequest,
} from "@toktracker/shared";
import type { TimeRange } from "@toktracker/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { Store } from "./store";

const TIME_RANGES = new Set<TimeRange>(["day", "week", "month", "year", "all"]);
const app = new Hono();
const store = new Store();
const accessKey = process.env.TOKTRACKER_API_KEY;
const hasValidAccessKey = (authorization: string | undefined): boolean =>
  !accessKey || authorization === `Bearer ${accessKey}`;
app.use("/api/*", cors());
app.get("/api/health", (c) => {
  const authorization = c.req.header("authorization");
  if (!hasValidAccessKey(authorization)) {
    return c.json({ error: "Invalid encryption key" }, 401);
  }
  return c.json({
    keyRequired: Boolean(accessKey),
    ok: true,
    service: "toktracker-gateway",
  });
});
app.post("/api/v1/ingest", async (c) => {
  if (!hasValidAccessKey(c.req.header("authorization"))) {
    return c.json({ error: "A valid access key is required" }, 401);
  }
  const submittedBody: unknown = await c.req.json().catch(() => null);
  if (accessKey && !isEncryptedPayload(submittedBody)) {
    return c.json({ error: "An encrypted ingestion payload is required" }, 400);
  }
  let body = submittedBody;
  if (accessKey && isEncryptedPayload(submittedBody)) {
    try {
      body = await decryptPayload(submittedBody, accessKey);
    } catch {
      return c.json({ error: "Could not decrypt ingestion payload" }, 400);
    }
  }
  if (!isIngestRequest(body)) {
    return c.json({ error: "Invalid ingestion payload" }, 400);
  }
  return c.json(store.ingest(body));
});
app.get("/api/v1/sessions/search", (c) => {
  const devices = c.req.query("devices")?.split(",").filter(Boolean) ?? [];
  const agents = c.req.query("agents")?.split(",").filter(Boolean) ?? [];
  const limit =
    c.req.query("limit") === "all" ? Number.MAX_SAFE_INTEGER : undefined;
  return c.json(store.sessions(c.req.query("q") ?? "", devices, agents, limit));
});
app.get("/api/v1/sessions/:id", (c) => {
  const devices = c.req.query("devices")?.split(",").filter(Boolean) ?? [];
  const session = store.session(c.req.param("id"), devices);
  return session
    ? c.json(session)
    : c.json({ error: "Session not found" }, 404);
});
app.get("/api/v1/summary", (c) => {
  const devices = c.req.query("devices")?.split(",").filter(Boolean) ?? [];
  const requestedRange = c.req.query("range") as TimeRange | undefined;
  const range =
    requestedRange && TIME_RANGES.has(requestedRange)
      ? requestedRange
      : "month";
  return c.json(store.summary(devices, range));
});

const dashboardDir =
  process.env.TOKTRACKER_DASHBOARD_DIR ??
  new URL("dashboard/", import.meta.url).pathname;
app.get("*", async (c) => {
  const requested = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
  const candidate = Bun.file(`${dashboardDir}/${requested}`);
  const file = (await candidate.exists())
    ? candidate
    : Bun.file(`${dashboardDir}/index.html`);
  if (!(await file.exists())) {
    return c.text("Dashboard not built. Run `bun run build:dashboard`.", 503);
  }
  return new Response(file);
});

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
export default { fetch: app.fetch, hostname, port };
console.log(`TokTracker gateway listening on http://localhost:${port}`);
