/* eslint-disable no-await-in-loop */
// Setup is deliberately interactive, and connection attempts must be sequential.
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, networkInterfaces, platform } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";

import { ensureLauncher, readActiveInstallation } from "./installation";
import {
  applicationDirectory,
  applicationRoot,
  dataDirectory,
  readConfig,
  writeConfig,
} from "./runtime-config";
import type { ServiceRole } from "./runtime-config";
import {
  bold,
  CliError,
  cyan,
  dim,
  formatTable,
  printStep,
  printSuccess,
  printWarning,
  red,
  symbols,
} from "./ui";

const { join } = path;
let terminal: Interface | undefined;
let cancellation: AbortController | undefined;

const cancelledError = (): CliError =>
  new CliError("Setup cancelled; nothing was changed");

const ask = async (
  question: string,
  fallback?: string,
  fallbackLabel = fallback
): Promise<string> => {
  if (!terminal) {
    throw new Error("Setup terminal is unavailable");
  }
  const suffix = fallbackLabel ? ` ${dim(`(${fallbackLabel})`)}` : "";
  const signal = cancellation?.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw cancelledError();
  }
  let answer: string;
  try {
    answer = await terminal.question(
      `${cyan("?")} ${bold(question)}${suffix} `,
      { signal }
    );
  } catch (error) {
    if (signal.aborted) {
      throw cancelledError();
    }
    throw error;
  }
  // Bun resolves pending questions with "" when the interface closes.
  if (signal.aborted) {
    throw cancelledError();
  }
  return answer.trim() || fallback || "";
};
/** Re-asks until the answer parses, instead of aborting the whole setup. */
const askUntilValid = async (
  question: string,
  fallback: string,
  parse: (value: string) => string
): Promise<string> => {
  for (;;) {
    const answer = await ask(question, fallback);
    try {
      return parse(answer);
    } catch (error) {
      console.log(
        `  ${red(`${symbols.error} ${error instanceof Error ? error.message : String(error)}`)}`
      );
    }
  }
};
const confirm = async (
  question: string,
  defaultValue = true
): Promise<boolean> => {
  for (;;) {
    const response = await ask(
      question,
      undefined,
      defaultValue ? "Y/n" : "y/N"
    );
    const answer = response.toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    console.log(`  ${red(`${symbols.error} Please answer y or n`)}`);
  }
};
const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// Unit values are not JSON. Escape whitespace as systemd C-style escapes so
// executable paths remain valid without relying on shell-style quoting, and
// double "%" so paths cannot trigger specifier expansion.
const systemdEscape = (value: string): string =>
  value
    .replaceAll(
      /[\s\\"']/gu,
      (character) =>
        `\\x${(character.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`
    )
    .replaceAll("%", "%%");
// ExecStart additionally expands $VARIABLES, so "$" must be doubled there.
const systemdExecEscape = (value: string): string =>
  systemdEscape(value).replaceAll("$", "$$$$");

const run = (command: string[]): boolean => {
  const result = Bun.spawnSync(command, {
    stderr: "inherit",
    stdout: "inherit",
  });
  return result.exitCode === 0;
};

export const installService = async (
  serviceRole: ServiceRole
): Promise<void> => {
  const serviceName = `toktracker-${serviceRole}`;
  const activeInstallation = await readActiveInstallation(serviceRole);
  const [, currentCliPath] = process.argv;
  if (!currentCliPath) {
    throw new Error("Could not determine the TokTracker CLI path");
  }
  const serviceEntrypoint = activeInstallation
    ? await ensureLauncher(serviceRole)
    : currentCliPath;
  const workingDirectory = activeInstallation
    ? applicationDirectory()
    : applicationRoot();
  if (platform() === "linux") {
    const unitDirectory = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDirectory, `${serviceName}.service`);
    await mkdir(unitDirectory, { recursive: true });
    await Bun.write(
      unitPath,
      `[Unit]\nDescription=TokTracker ${serviceRole}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdEscape(workingDirectory)}\nExecStart=${systemdExecEscape(process.execPath)} ${systemdExecEscape(serviceEntrypoint)} run-service\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`
    );
    const installed =
      run(["systemctl", "--user", "daemon-reload"]) &&
      run(["systemctl", "--user", "enable", "--now", serviceName]);
    if (!installed) {
      throw new CliError(
        `Could not enable ${unitPath}`,
        "Make sure systemd user services are available (systemctl --user status)."
      );
    }
    printSuccess(`Installed systemd user service ${dim(unitPath)}`);
    return;
  }

  if (platform() === "darwin") {
    const label = `dev.toktracker.${serviceRole}`;
    const agentsDirectory = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(agentsDirectory, `${label}.plist`);
    await mkdir(agentsDirectory, { recursive: true });
    await Bun.write(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(serviceEntrypoint)}</string><string>run-service</string></array>\n<key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n`
    );
    const domain = `gui/${process.getuid?.() ?? 501}`;
    Bun.spawnSync(["launchctl", "bootout", domain, plistPath]);
    if (!run(["launchctl", "bootstrap", domain, plistPath])) {
      throw new Error(`Could not load ${plistPath}`);
    }
    printSuccess(`Installed launchd service ${dim(plistPath)}`);
    return;
  }

  if (platform() === "win32") {
    const taskName = `TokTracker ${serviceRole}`;
    const taskCommand = `"${process.execPath}" "${serviceEntrypoint}" run-service`;
    const created = run([
      "schtasks.exe",
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      taskName,
      "/TR",
      taskCommand,
    ]);
    if (!created) {
      throw new Error(`Could not create Windows startup task ${taskName}`);
    }
    run(["schtasks.exe", "/Run", "/TN", taskName]);
    printSuccess(`Installed Windows startup task ${dim(taskName)}`);
    return;
  }

  throw new Error(`Unsupported platform: ${platform()}`);
};

const checkGateway = async (
  gatewayUrl: string,
  key?: string
): Promise<void> => {
  const response = await fetch(`${gatewayUrl}/api/health`, {
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) {
    throw new Error("the gateway rejected that encryption key");
  }
  if (!response.ok) {
    throw new Error(`Gateway returned HTTP ${response.status}`);
  }
};

const normalizeUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw new Error("expected a URL such as http://server:3000");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("the URL must start with http:// or https://");
  }
  return url.toString().replace(/\/$/u, "");
};

const generatedAccessKey = (): string =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");

const parsePort = (value: string): string => {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error("enter a port between 1 and 65535");
  }
  return value;
};
const parseBindAddress = (value: string): string => {
  if (isIP(value) === 0) {
    throw new Error("enter an IPv4 or IPv6 address without a port");
  }
  return value;
};
const isLoopbackHost = (host: string): boolean =>
  host === "::1" || host.startsWith("127.");

const configureGatewayNetwork = async (
  existing: Record<string, string>
): Promise<{
  accessKey: string;
  exposeToLan: boolean;
  host: string;
}> => {
  const existingKey = existing.TOKTRACKER_API_KEY ?? "";
  const existingHost = existing.HOST ?? "127.0.0.1";
  let accessKey = "";
  if (
    await confirm(
      "Protect and encrypt client uploads with a shared key?",
      Boolean(existingKey)
    )
  ) {
    accessKey = await ask(
      "Shared key",
      existingKey,
      existingKey ? "Enter keeps the current key" : "Enter generates one"
    );
    accessKey ||= generatedAccessKey();
  }
  const exposeToLan = await confirm(
    "Allow other devices on your network to connect?",
    !isLoopbackHost(existingHost)
  );
  if (!exposeToLan) {
    return { accessKey, exposeToLan, host: "127.0.0.1" };
  }
  if (!accessKey) {
    printStep("Network access requires a shared key, so one was generated.");
    accessKey = generatedAccessKey();
  }
  printWarning(
    "Network access exposes usage metadata. Firewall the port and keep the key private."
  );
  const host = await askUntilValid(
    "Bind address (0.0.0.0 listens on every IPv4 interface)",
    isLoopbackHost(existingHost) ? "0.0.0.0" : existingHost,
    parseBindAddress
  );
  return { accessKey, exposeToLan, host };
};
const gatewayAddresses = (
  host: string,
  port: string,
  exposeToLan: boolean
): Set<string> => {
  const addresses = new Set<string>([`http://localhost:${port}`]);
  if (!exposeToLan) {
    return addresses;
  }
  if (host !== "0.0.0.0") {
    addresses.add(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
    return addresses;
  }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.add(`http://${entry.address}:${port}`);
      }
    }
  }
  return addresses;
};

const askUpdateChannel = async (
  existing: Record<string, string>
): Promise<"nightly" | "stable"> =>
  (await confirm(
    "Receive nightly prerelease updates?",
    existing.TOKTRACKER_UPDATE_CHANNEL === "nightly"
  ))
    ? "nightly"
    : "stable";

const printSummary = (title: string, rows: string[][]): void => {
  console.log(`\n${bold(title)}`);
  console.log(formatTable(rows, "  "));
};

const printNextSteps = (steps: readonly string[]): void => {
  console.log(`\n${bold("Next steps")}`);
  for (const [index, step] of steps.entries()) {
    console.log(`  ${dim(`${index + 1}.`)} ${step}`);
  }
};

const setupGateway = async (
  existing: Record<string, string>
): Promise<void> => {
  const port = await askUntilValid(
    "Gateway port",
    existing.PORT ?? "3000",
    parsePort
  );
  const { accessKey, exposeToLan, host } =
    await configureGatewayNetwork(existing);
  const updateChannel = await askUpdateChannel(existing);
  console.log("");
  const config = await writeConfig("gateway", {
    ...existing,
    HOST: host,
    PORT: port,
    TOKTRACKER_API_KEY: accessKey,
    TOKTRACKER_DB:
      existing.TOKTRACKER_DB || join(dataDirectory("gateway"), "toktracker.db"),
    TOKTRACKER_UPDATE_CHANNEL: updateChannel,
  });
  printSuccess(`Saved settings to ${dim(config)}`);
  await installService("gateway");
  const [localUrl = `http://localhost:${port}`, ...networkUrls] =
    gatewayAddresses(host, port, exposeToLan);
  const rows = [["Dashboard", cyan(localUrl)]];
  for (const [index, url] of networkUrls.entries()) {
    rows.push([index === 0 ? "Network URLs" : "", cyan(url)]);
  }
  rows.push(["Shared key", accessKey ? bold(accessKey) : dim("none")]);
  printSummary("TokTracker gateway is ready", rows);
  printNextSteps([
    `Create a pairing code: ${bold("toktracker-gateway auth code")}`,
    `Open ${cyan(localUrl)} and enter the code`,
    `Install the client on each computer to track, using ${networkUrls.length > 0 ? "a network URL" : "the dashboard URL"}${accessKey ? " and the shared key" : ""}`,
  ]);
};

const setupClient = async (existing: Record<string, string>): Promise<void> => {
  let gatewayUrl = "";
  let accessKey = existing.TOKTRACKER_API_KEY ?? "";
  while (!gatewayUrl) {
    const candidate = await askUntilValid(
      "Gateway URL",
      existing.TOKTRACKER_GATEWAY ?? "http://localhost:3000",
      normalizeUrl
    );
    accessKey = await ask(
      "Shared key",
      accessKey,
      accessKey
        ? "Enter keeps the current key"
        : "leave blank if the gateway has none"
    );
    printStep(`Checking ${candidate}`);
    try {
      await checkGateway(candidate, accessKey);
      gatewayUrl = candidate;
      printSuccess("Connected to the gateway");
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === "TimeoutError") {
        reason = "the gateway did not respond within 5 seconds";
      }
      console.log(`  ${red(`${symbols.error} Could not connect: ${reason}`)}`);
      console.log(dim("  Check the URL and key, then try again.\n"));
    }
  }
  const updateChannel = await askUpdateChannel(existing);
  const gatewayProviderSettings = await confirm(
    "Let the gateway manage provider settings on this computer?",
    existing.TOKTRACKER_GATEWAY_PROVIDER_SETTINGS !== "0"
  );
  console.log("");
  const config = await writeConfig("client", {
    ...existing,
    TOKTRACKER_API_KEY: accessKey,
    TOKTRACKER_DATA_DIR:
      existing.TOKTRACKER_DATA_DIR || dataDirectory("client"),
    TOKTRACKER_GATEWAY: gatewayUrl,
    TOKTRACKER_GATEWAY_PROVIDER_SETTINGS: gatewayProviderSettings ? "1" : "0",
    TOKTRACKER_UPDATE_CHANNEL: updateChannel,
  });
  printSuccess(`Saved settings to ${dim(config)}`);
  await installService("client");
  printSummary("TokTracker client is ready", [
    ["Uploading to", cyan(gatewayUrl)],
    ["Updates", updateChannel],
  ]);
  printNextSteps([
    "Usage appears in the dashboard after the first scan (within a few minutes)",
    `Check on the client any time with ${bold("toktracker-client status")}`,
  ]);
};

export const setupRole = async (role: ServiceRole): Promise<void> => {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "Setup needs an interactive terminal",
      `Run ${bold(`toktracker-${role} setup`)} directly rather than through a pipe.`
    );
  }
  const existing = await readConfig(role);
  terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  cancellation = new AbortController();
  terminal.on("SIGINT", () => {
    cancellation?.abort();
    console.log("");
  });
  try {
    console.log(`${bold(`TokTracker ${role} setup`)}`);
    console.log(
      dim(
        Object.keys(existing).length > 0
          ? "Press Enter to keep the current value shown in parentheses.\n"
          : "Press Enter to accept the default shown in parentheses.\n"
      )
    );
    const setup = role === "gateway" ? setupGateway : setupClient;
    await setup(existing);
  } finally {
    terminal?.close();
    terminal = undefined;
    cancellation = undefined;
  }
};
