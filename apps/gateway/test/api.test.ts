/* eslint-disable vitest/prefer-importing-vitest-globals */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { encryptPayload } from "@toktracker/shared";
import type { IngestRequest } from "@toktracker/shared";
import { z } from "zod";

import { createApp } from "../src/app";
import { Store } from "../src/store";

const resources: { directory: string; store: Store }[] = [];
const testStore = async (): Promise<Store> => {
  const directory = await mkdtemp(path.join(tmpdir(), "toktracker-api-test-"));
  const store = new Store(path.join(directory, "gateway.db"));
  resources.push({ directory, store });
  return store;
};

const responseCookies = (response: Response): string[] =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter(Boolean);

const pairDashboard = async (
  app: ReturnType<typeof createApp>,
  store: Store
) => {
  const { code } = store.createDashboardPairingCode();
  const response = await app.request("/api/v1/auth/pair", {
    body: JSON.stringify({ code, deviceName: "Test browser" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const accessCookie = responseCookies(response).find((cookie) =>
    cookie.startsWith("toktracker_access=")
  );
  if (!accessCookie) {
    throw new Error("Pairing did not return an access cookie");
  }
  return { cookie: accessCookie };
};

const manySessions = (count: number): IngestRequest => ({
  device: { id: "device", name: "Device", platform: "test" },
  sessions: Array.from({ length: count }, (_, index) => {
    const sessionId = `session-${index}`;
    return {
      deviceId: "device",
      messages: [
        {
          client: "codex",
          cost: 0,
          costSource: "unknown" as const,
          date: "2026-01-01",
          isTurnStart: true,
          messageCount: 1,
          modelId: "gpt-5",
          providerId: "openai",
          sessionId,
          timestamp: index + 1,
          tokens: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 1,
            output: 0,
            reasoning: 0,
          },
        },
      ],
      sessionId,
      sourceMtimeMs: 1,
      sourcePath: `/sessions/${sessionId}.jsonl`,
      sourceSize: 1,
    };
  }),
});

afterEach(async () => {
  const cleanup = resources.splice(0).map(({ directory, store }) => {
    store.close();
    return rm(directory, { force: true, recursive: true });
  });
  await Promise.all(cleanup);
});

describe("gateway API", () => {
  test("limits the shared ingestion key to client endpoints", async () => {
    const store = await testStore();
    const app = createApp(store, "secret");
    const unauthorizedHealth = await app.request("/api/health");
    expect(unauthorizedHealth.status).toBe(401);
    const authorizedHealth = await app.request("/api/health", {
      headers: { authorization: "Bearer secret" },
    });
    expect(authorizedHealth.status).toBe(200);
    const dashboardWithIngestionKey = await app.request("/api/v1/summary", {
      headers: { authorization: "Bearer secret" },
    });
    expect(dashboardWithIngestionKey.status).toBe(401);
  });

  test("allows dashboard requests when dashboard authentication is disabled", async () => {
    const store = await testStore();
    const app = createApp(store, undefined, false);

    const response = await app.request("/api/v1/summary");

    expect(response.status).toBe(200);
  });

  test("adds restrictive browser security headers", async () => {
    const store = await testStore();
    const app = createApp(store, undefined, false);

    const response = await app.request("/api/health");

    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'"
    );
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("does not serve files outside the dashboard directory", async () => {
    const store = await testStore();
    const dashboardDirectory = path.join(
      resources.at(-1)?.directory ?? "",
      "dashboard"
    );
    await mkdir(dashboardDirectory);
    await writeFile(path.join(dashboardDirectory, "index.html"), "dashboard");
    await writeFile(
      path.join(path.dirname(dashboardDirectory), "secret.txt"),
      "secret"
    );
    const previousDashboardDirectory = process.env.TOKTRACKER_DASHBOARD_DIR;
    process.env.TOKTRACKER_DASHBOARD_DIR = dashboardDirectory;
    try {
      const app = createApp(store, undefined, false);
      const response = await app.request("/../secret.txt");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("dashboard");
    } finally {
      if (previousDashboardDirectory === undefined) {
        delete process.env.TOKTRACKER_DASHBOARD_DIR;
      } else {
        process.env.TOKTRACKER_DASHBOARD_DIR = previousDashboardDirectory;
      }
    }
  });

  test("pairs a dashboard once, rotates refresh tokens, and revokes devices", async () => {
    const store = await testStore();
    const app = createApp(store, "");
    const { code } = store.createDashboardPairingCode();
    const paired = await app.request("/api/v1/auth/pair", {
      body: JSON.stringify({ code, deviceName: "Test browser" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(paired.status).toBe(200);
    const pairedCookies = responseCookies(paired);
    const accessCookie = pairedCookies.find((cookie) =>
      cookie.startsWith("toktracker_access=")
    );
    const refreshCookie = pairedCookies.find((cookie) =>
      cookie.startsWith("toktracker_refresh=")
    );
    expect(accessCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();

    const authorized = await app.request("/api/v1/summary", {
      headers: { cookie: accessCookie ?? "" },
    });
    expect(authorized.status).toBe(200);

    const refreshed = await app.request("/api/v1/auth/refresh", {
      headers: { cookie: refreshCookie ?? "" },
      method: "POST",
    });
    expect(refreshed.status).toBe(200);
    const refreshedCookies = responseCookies(refreshed);
    const refreshedAccess = refreshedCookies.find((cookie) =>
      cookie.startsWith("toktracker_access=")
    );
    const replayedRefresh = await app.request("/api/v1/auth/refresh", {
      headers: { cookie: refreshCookie ?? "" },
      method: "POST",
    });
    expect(replayedRefresh.status).toBe(401);

    const [device] = store.dashboardDevices();
    expect(device?.name).toBe("Test browser");
    expect(store.revokeDashboardDevice(device?.id ?? "")).toBe(true);
    const revoked = await app.request("/api/v1/summary", {
      headers: { cookie: refreshedAccess ?? "" },
    });
    expect(revoked.status).toBe(401);

    const reusedCode = await app.request("/api/v1/auth/pair", {
      body: JSON.stringify({ code, deviceName: "Another browser" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(reusedCode.status).toBe(401);
  });

  test("serves dashboard-configured client update policies", async () => {
    const store = await testStore();
    const app = createApp(store, "");
    const unauthorized = await app.request(
      "/api/v1/settings/client-auto-update"
    );
    expect(unauthorized.status).toBe(401);

    const headers = await pairDashboard(app, store);
    const saved = await app.request("/api/v1/settings/client-auto-update", {
      body: JSON.stringify({
        channel: "nightly",
        enabled: true,
        windowEndHour: 4,
        windowStartHour: 2,
      }),
      headers: { ...headers, "content-type": "application/json" },
      method: "PUT",
    });
    expect(saved.status).toBe(200);

    const policy = await app.request("/api/v1/client-update-policy");
    expect(policy.status).toBe(200);
    expect(await policy.json()).toEqual({
      channel: "nightly",
      enabled: true,
      windowEndHour: 4,
      windowStartHour: 2,
    });
  });

  test("rejects non-object client update settings", async () => {
    const store = await testStore();
    const app = createApp(store, "");
    const headers = await pairDashboard(app, store);

    const responses = await Promise.all(
      [null, [], true, 1, "settings"].map(async (body) => {
        const response = await app.request(
          "/api/v1/settings/client-auto-update",
          {
            body: JSON.stringify(body),
            headers: { ...headers, "content-type": "application/json" },
            method: "PUT",
          }
        );
        return { body: await response.json(), status: response.status };
      })
    );
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid update settings" });
    }
  });

  test("exposes Cursor dashboard settings and queues account commands", async () => {
    const store = await testStore();
    const app = createApp(store, "");
    const unauthorized = await app.request("/api/v1/settings/cursor");
    expect(unauthorized.status).toBe(401);

    const headers = await pairDashboard(app, store);
    const overview = await app.request("/api/v1/settings/cursor", { headers });
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      devices: [],
      enabled: true,
    });

    const saved = await app.request("/api/v1/settings/cursor", {
      body: JSON.stringify({ enabled: true, syncIntervalMs: 120_000 }),
      headers: { ...headers, "content-type": "application/json" },
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      enabled: true,
      includeAutomations: false,
      includeCloudAgents: true,
      syncIntervalMs: 120_000,
      useT3CodeLocalSessions: false,
    });

    const queued = await app.request("/api/v1/settings/cursor/accounts", {
      body: JSON.stringify({
        deviceId: "client-1",
        label: "work",
        token: "user_abc%3A%3Atoken",
      }),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    });
    expect(queued.status).toBe(200);

    const policy = await app.request(
      "/api/v1/client-cursor-policy?deviceId=client-1"
    );
    expect(policy.status).toBe(200);
    const policyBody = z
      .object({
        commands: z.array(
          z.object({
            label: z.string().optional(),
            token: z.string().optional(),
            type: z.string(),
          })
        ),
        syncIntervalMs: z.number(),
      })
      .parse(await policy.json());
    expect(policyBody.syncIntervalMs).toBe(120_000);
    expect(policyBody.commands).toEqual([
      expect.objectContaining({
        label: "work",
        token: "user_abc%3A%3Atoken",
        type: "add-account",
      }),
    ]);

    const status = await app.request("/api/v1/client-cursor-status", {
      body: JSON.stringify({
        accounts: [{ id: "user_abc", isActive: true, label: "work" }],
        desktopEmail: "work@example.com",
        desktopSignedIn: true,
        deviceId: "client-1",
        syncIntervalMs: 120_000,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(status.status).toBe(200);
    const reported = await app.request("/api/v1/settings/cursor", { headers });
    expect(await reported.json()).toMatchObject({
      devices: [
        expect.objectContaining({
          desktopEmail: "work@example.com",
          desktopSignedIn: true,
          deviceId: "client-1",
        }),
      ],
    });
  });

  test("authenticates encrypted ingestion without exposing the key and rejects replays", async () => {
    const store = await testStore();
    const app = createApp(store, "secret");
    const payload = {
      ...manySessions(1),
      requestId: crypto.randomUUID(),
      sentAt: Date.now(),
    };
    const body = JSON.stringify(await encryptPayload(payload, "secret"));
    const request = () =>
      app.request("/api/v1/ingest", {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    const accepted = await request();
    const replayed = await request();
    expect(accepted.status).toBe(200);
    expect(replayed.status).toBe(409);
    expect(store.sessions("", [], [], 20)).toHaveLength(1);
  });

  test("rejects malformed ingestion and oversized declared bodies", async () => {
    const store = await testStore();
    const app = createApp(store, "");
    const malformed = await app.request("/api/v1/ingest", {
      body: JSON.stringify({ device: { id: "x", name: "x" }, sessions: [] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(malformed.status).toBe(400);

    const oversized = await app.request("/api/v1/ingest", {
      body: "{}",
      headers: {
        "content-length": String(17 * 1024 * 1024),
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(oversized.status).toBe(413);
  });

  test("caps and paginates session search results", async () => {
    const store = await testStore();
    store.ingest(manySessions(210));
    const app = createApp(store, "");
    const headers = await pairDashboard(app, store);
    const firstResponse = await app.request(
      "/api/v1/sessions/search?limit=all",
      { headers }
    );
    // SAFETY: test and demo fixtures are constructed with the asserted application contract.
    const first = (await firstResponse.json()) as unknown[];
    const secondResponse = await app.request(
      "/api/v1/sessions/search?limit=200&offset=200",
      { headers }
    );
    // SAFETY: test and demo fixtures are constructed with the asserted application contract.
    const second = (await secondResponse.json()) as unknown[];
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(10);
  });
});
