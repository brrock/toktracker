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
  configPath,
  dataDirectory,
  writeConfig,
} from "./runtime-config";
import type { ServiceRole } from "./runtime-config";

const { join } = path;
let terminal: Interface | undefined;

const ask = async (question: string, fallback?: string): Promise<string> => {
  if (!terminal) {
    throw new Error("Setup terminal is unavailable");
  }
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await terminal.question(`${question}${suffix}: `);
  return answer.trim() || fallback || "";
};
const confirm = async (
  question: string,
  defaultValue = true
): Promise<boolean> => {
  const response = await ask(`${question} (${defaultValue ? "Y/n" : "y/N"})`);
  const answer = response.toLowerCase();
  return answer ? answer === "y" || answer === "yes" : defaultValue;
};
const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// Unit values are not JSON. Escape whitespace as systemd C-style escapes so
// executable paths remain valid without relying on shell-style quoting.
const systemdEscape = (value: string): string =>
  value.replaceAll(
    /[\s\\"]/gu,
    (character) =>
      `\\x${(character.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`
  );

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
      `[Unit]\nDescription=TokTracker ${serviceRole}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdEscape(workingDirectory)}\nExecStart=${systemdEscape(process.execPath)} ${systemdEscape(serviceEntrypoint)} run-service\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`
    );
    const installed =
      run(["systemctl", "--user", "daemon-reload"]) &&
      run(["systemctl", "--user", "enable", "--now", serviceName]);
    if (!installed) {
      throw new Error(`Could not enable ${unitPath}`);
    }
    console.log(`Installed systemd user service: ${unitPath}`);
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
    console.log(`Installed launchd service: ${plistPath}`);
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
    console.log(`Installed Windows startup task: ${taskName}`);
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
    throw new Error("Wrong encryption key");
  }
  if (!response.ok) {
    throw new Error(`Gateway returned HTTP ${response.status}`);
  }
};

const normalizeUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://");
  }
  return url.toString().replace(/\/$/u, "");
};

const generatedAccessKey = (): string =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");

const configureGatewayNetwork = async (): Promise<{
  accessKey: string;
  exposeToLan: boolean;
  host: string;
}> => {
  let accessKey = "";
  if (
    await confirm(
      "Protect and encrypt client ingestion with a shared key",
      false
    )
  ) {
    accessKey = await ask("Client ingestion key (leave blank to generate)");
    accessKey ||= generatedAccessKey();
  }
  const exposeToLan = await confirm(
    "Expose the gateway to other devices on your LAN",
    false
  );
  if (exposeToLan && !accessKey) {
    console.log("LAN access requires a shared key; generating one now.");
    accessKey = generatedAccessKey();
  }
  if (!exposeToLan) {
    return { accessKey, exposeToLan, host: "127.0.0.1" };
  }
  console.log(
    "Warning: LAN access exposes usage metadata. Firewall the port and keep the generated key private."
  );
  const host = await ask(
    "Gateway bind address (leave as 0.0.0.0 for all IPv4 interfaces)",
    "0.0.0.0"
  );
  if (isIP(host) === 0) {
    throw new Error(
      "Bind address must be an IPv4 or IPv6 address without a port"
    );
  }
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

const setupGateway = async (): Promise<void> => {
  const port = await ask("Gateway port", "3000");
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("Port must be between 1 and 65535");
  }
  const { accessKey, exposeToLan, host } = await configureGatewayNetwork();
  const updateChannel = (await confirm(
    "Receive nightly prerelease updates",
    false
  ))
    ? "nightly"
    : "stable";
  const config = await writeConfig("gateway", {
    HOST: host,
    PORT: port,
    TOKTRACKER_API_KEY: accessKey,
    TOKTRACKER_DB: join(dataDirectory("gateway"), "toktracker.db"),
    TOKTRACKER_UPDATE_CHANNEL: updateChannel,
  });
  await installService("gateway");
  const addresses = gatewayAddresses(host, port, exposeToLan);
  console.log(`\nGateway configured in ${config}`);
  console.log("Use one of these URLs when setting up a client:");
  for (const address of addresses) {
    console.log(`  ${address}`);
  }
  if (accessKey) {
    console.log(`Client ingestion key: ${accessKey}`);
  }
};

const setupClient = async (): Promise<void> => {
  let gatewayUrl = "";
  let accessKey = "";
  while (!gatewayUrl) {
    try {
      const candidate = normalizeUrl(
        await ask("Gateway URL", "http://localhost:3000")
      );
      accessKey = await ask("Gateway encryption key (leave blank if none)");
      await checkGateway(candidate, accessKey);
      gatewayUrl = candidate;
    } catch (error) {
      console.error(
        `Gateway check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      console.log("Please enter a different URL or key.\n");
    }
  }
  const updateChannel = (await confirm(
    "Receive nightly prerelease updates",
    false
  ))
    ? "nightly"
    : "stable";
  const gatewayProviderSettings = await confirm(
    "Can the gateway control your provider settings",
    true
  );
  const config = await writeConfig("client", {
    TOKTRACKER_API_KEY: accessKey,
    TOKTRACKER_DATA_DIR: dataDirectory("client"),
    TOKTRACKER_GATEWAY: gatewayUrl,
    TOKTRACKER_GATEWAY_PROVIDER_SETTINGS: gatewayProviderSettings ? "1" : "0",
    TOKTRACKER_UPDATE_CHANNEL: updateChannel,
  });
  await installService("client");
  console.log(`\nClient configured in ${config}`);
  console.log(`Uploading to ${gatewayUrl}`);
};

export const setupRole = async (role: ServiceRole): Promise<void> => {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Setup requires an interactive terminal. Run this command directly, not through a pipe."
    );
  }
  terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    console.log(`TokTracker ${role} setup\nConfig: ${configPath(role)}\n`);
    const setup = role === "gateway" ? setupGateway : setupClient;
    await setup();
  } finally {
    terminal.close();
    terminal = undefined;
  }
};
