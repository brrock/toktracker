import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { Store } from "../apps/gateway/src/store";
import { createDemoPayloads } from "./demo-data";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const demoData = path.join(repositoryRoot, ".demo-data");
const gatewayData = path.join(demoData, "gateway");
const dashboardPort = process.env.TOKTRACKER_DEMO_DASHBOARD_PORT ?? "5174";
const gatewayPort = process.env.TOKTRACKER_DEMO_GATEWAY_PORT ?? "4311";
const gatewayUrl = `http://localhost:${gatewayPort}`;

await rm(demoData, { force: true, recursive: true });
await mkdir(gatewayData, { recursive: true });

const environment = {
  ...process.env,
  PORT: gatewayPort,
  TOKTRACKER_DASHBOARD_PORT: dashboardPort,
  TOKTRACKER_DB: path.join(gatewayData, "toktracker.db"),
  TOKTRACKER_GATEWAY: gatewayUrl,
};
const commands = [
  [process.execPath, "run", "--cwd", "apps/gateway", "dev"],
  [process.execPath, "run", "--cwd", "apps/dashboard", "dev"],
] as const;
const processes = commands.map((command) =>
  Bun.spawn([...command], {
    cwd: repositoryRoot,
    env: environment,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  })
);

const waitForGateway = async (attempt = 0): Promise<void> => {
  try {
    const response = await fetch(`${gatewayUrl}/api/health`);
    if (response.ok) {
      return;
    }
  } catch {
    // The gateway is still starting.
  }
  if (attempt === 49) {
    throw new Error("Demo gateway did not start within five seconds.");
  }
  await Bun.sleep(100);
  return waitForGateway(attempt + 1);
};

const seedPayload = async (
  payload: ReturnType<typeof createDemoPayloads>[number]
): Promise<void> => {
  const response = await fetch(`${gatewayUrl}/api/v1/ingest`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Could not seed demo data (${response.status}).`);
  }
};

let pairingCode = "";
try {
  await waitForGateway();
  await Promise.all(createDemoPayloads().map(seedPayload));
  const store = new Store(environment.TOKTRACKER_DB);
  pairingCode = store.createDashboardPairingCode().code;
  store.close();
} catch (error) {
  for (const child of processes) {
    child.kill();
  }
  throw error;
}

process.stdout.write(
  [
    "TokTracker demo started with generated mock data:",
    `  Dashboard: http://localhost:${dashboardPort}`,
    `  Gateway:   ${gatewayUrl}`,
    `  Data:      ${demoData}`,
    `  Pairing code: ${pairingCode}`,
    "  Stop with Ctrl+C. Demo data is reset on every start.",
    "",
  ].join("\n")
);

let stopping = false;
const stop = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of processes) {
    child.kill();
  }
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const exitCode = await Promise.race(processes.map((child) => child.exited));
stop();
await Promise.allSettled(processes.map((child) => child.exited));
process.exitCode = exitCode;
