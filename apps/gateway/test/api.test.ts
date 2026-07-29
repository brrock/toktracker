/* eslint-disable vitest/prefer-importing-vitest-globals */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IngestRequest } from "@toktracker/shared";

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
    const first = (await firstResponse.json()) as unknown[];
    const secondResponse = await app.request(
      "/api/v1/sessions/search?limit=200&offset=200",
      { headers }
    );
    const second = (await secondResponse.json()) as unknown[];
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(10);
  });
});
