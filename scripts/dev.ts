import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const developmentData = path.join(repositoryRoot, ".dev-data");
const gatewayData = path.join(developmentData, "gateway");
const clientData = path.join(developmentData, "client");

if (process.env.TOKTRACKER_DEV_RESET === "1") {
  await rm(developmentData, { force: true, recursive: true });
}
await Promise.all([
  mkdir(gatewayData, { recursive: true }),
  mkdir(clientData, { recursive: true }),
]);

const dashboardPort = process.env.TOKTRACKER_DEV_DASHBOARD_PORT ?? "5173";
const gatewayPort = process.env.TOKTRACKER_DEV_GATEWAY_PORT ?? "4310";
const gatewayUrl = `http://localhost:${gatewayPort}`;
const sharedEnvironment = {
  ...process.env,
  PORT: gatewayPort,
  TOKTRACKER_DASHBOARD_PORT: dashboardPort,
  TOKTRACKER_DATA_DIR: clientData,
  TOKTRACKER_DB: path.join(gatewayData, "toktracker.db"),
  TOKTRACKER_GATEWAY: gatewayUrl,
};

const commands = [
  [process.execPath, "run", "--cwd", "apps/gateway", "dev"],
  [process.execPath, "run", "--cwd", "apps/dashboard", "dev"],
  [process.execPath, "run", "--cwd", "apps/client", "dev"],
] as const;

const processes = commands.map((command) =>
  Bun.spawn([...command], {
    cwd: repositoryRoot,
    env: sharedEnvironment,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  })
);

process.stdout.write(
  [
    "TokTracker development mode started:",
    `  Dashboard: http://localhost:${dashboardPort}`,
    `  Gateway:   ${gatewayUrl}`,
    `  Data:      ${developmentData}`,
    "  Reset:     TOKTRACKER_DEV_RESET=1 bun run dev",
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
