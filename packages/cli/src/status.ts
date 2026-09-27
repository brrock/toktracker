import { platform } from "node:os";

import packageJson from "../package.json" with { type: "json" };
import { readActiveInstallation, readReleaseManifest } from "./installation";
import { applicationRoot, configPath, readConfig } from "./runtime-config";
import type { ServiceRole } from "./runtime-config";
import { bold, dim, formatTable, green, red, yellow } from "./ui";

const HEALTH_TIMEOUT_MS = 3000;

export type ServiceState = "not installed" | "running" | "stopped" | "unknown";

/** The version the user is running: the active release, else the checkout. */
export const currentVersion = async (role: ServiceRole): Promise<string> => {
  try {
    const active = await readActiveInstallation(role);
    const manifest = active
      ? undefined
      : await readReleaseManifest(applicationRoot());
    const version = active?.version ?? manifest?.version;
    if (version) {
      return version;
    }
  } catch {
    // Corrupt install metadata should not hide the version entirely.
  }
  return `v${packageJson.version} (source checkout)`;
};

const commandOutput = (command: string[]) => {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  return { ok: result.exitCode === 0, text: result.stdout.toString().trim() };
};

export const serviceState = (role: ServiceRole): ServiceState => {
  try {
    if (platform() === "linux") {
      const unit = `toktracker-${role}`;
      const { text } = commandOutput([
        "systemctl",
        "--user",
        "is-active",
        unit,
      ]);
      if (text === "active" || text === "activating") {
        return "running";
      }
      // is-active prints nothing when the user bus is unreachable.
      if (text === "") {
        return "unknown";
      }
      const enabled = commandOutput([
        "systemctl",
        "--user",
        "is-enabled",
        unit,
      ]);
      return enabled.text === "" || enabled.text === "not-found"
        ? "not installed"
        : "stopped";
    }
    if (platform() === "darwin") {
      const domain = `gui/${process.getuid?.() ?? 501}`;
      const { ok, text } = commandOutput([
        "launchctl",
        "print",
        `${domain}/dev.toktracker.${role}`,
      ]);
      if (!ok) {
        return "not installed";
      }
      return text.includes("state = running") ? "running" : "stopped";
    }
    if (platform() === "win32") {
      const { ok, text } = commandOutput([
        "schtasks.exe",
        "/Query",
        "/TN",
        `TokTracker ${role}`,
      ]);
      if (!ok) {
        return "not installed";
      }
      return text.includes("Running") ? "running" : "stopped";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
};

const checkHealth = async (
  url: string,
  key: string | undefined
): Promise<string> => {
  try {
    const response = await fetch(`${url}/api/health`, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return red("rejected the encryption key");
    }
    return response.ok
      ? green("reachable")
      : red(`responded with HTTP ${response.status}`);
  } catch {
    return red("unreachable");
  }
};

const stateLabel = (state: ServiceState): string => {
  if (state === "running") {
    return green("running");
  }
  if (state === "stopped") {
    return yellow("stopped");
  }
  return state === "not installed" ? yellow("not installed") : dim("unknown");
};

const localGatewayUrl = (config: Record<string, string>): string => {
  const configuredHost = config.HOST ?? "127.0.0.1";
  const host =
    configuredHost === "0.0.0.0" || configuredHost === "::"
      ? "127.0.0.1"
      : configuredHost;
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${config.PORT ?? "3000"}`;
};

export const printStatus = async (role: ServiceRole): Promise<boolean> => {
  const executable = `toktracker-${role}`;
  const hasConfig = await Bun.file(configPath(role)).exists();
  const config = await readConfig(role);
  const version = await currentVersion(role);
  const state = serviceState(role);
  const channel = config.TOKTRACKER_UPDATE_CHANNEL || "stable";
  const rows: string[][] = [
    ["Version", `${version} ${dim(`· ${channel} channel`)}`],
    ["Config", hasConfig ? configPath(role) : yellow("not configured")],
    ["Service", stateLabel(state)],
  ];
  if (role === "gateway" && hasConfig) {
    const url = localGatewayUrl(config);
    rows.push(
      [
        "Gateway",
        `${url}  ${await checkHealth(url, config.TOKTRACKER_API_KEY)}`,
      ],
      ["Bind address", config.HOST ?? "127.0.0.1"]
    );
  }
  if (role === "client" && hasConfig) {
    const url = config.TOKTRACKER_GATEWAY;
    rows.push([
      "Gateway",
      url
        ? `${url}  ${await checkHealth(url, config.TOKTRACKER_API_KEY)}`
        : yellow("not set"),
    ]);
  }
  rows.push([
    "Encryption key",
    config.TOKTRACKER_API_KEY ? "set" : dim("not set"),
  ]);
  console.log(bold(`TokTracker ${role}`));
  console.log(formatTable(rows, "  "));
  if (!hasConfig) {
    console.log(`\nGet started with ${bold(`${executable} setup`)}`);
    return false;
  }
  if (state === "not installed") {
    console.log(
      `\nThe background service is not installed. Run ${bold(`${executable} setup`)}.`
    );
    return false;
  }
  return state !== "stopped";
};
