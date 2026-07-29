import { migrateLegacyGlobalInstallation } from "./installation";
import { installService, setupRole } from "./onboard";
import { runService } from "./run-service";
/* eslint-disable complexity, no-nested-ternary */
// Command dispatch remains centralized so role wrappers expose a consistent CLI.
import { configPath, readConfig, writeConfig } from "./runtime-config";
import type { ServiceRole } from "./runtime-config";
import {
  listInstalledVersions,
  restartService,
  rollbackRole,
  switchInstalledVersion,
  updateRole,
} from "./update";

interface ConfigField {
  environmentKey: string;
  sensitive?: boolean;
  validate?: (
    value: string,
    config: Record<string, string>
  ) => Promise<string> | string;
}

const normalizeUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway URL must use http:// or https://");
  }
  return url.toString().replace(/\/$/u, "");
};
const positiveInteger = (value: string): string => {
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error("Value must be a positive integer");
  }
  return value;
};
const port = (value: string): string => {
  positiveInteger(value);
  if (Number(value) > 65_535) {
    throw new Error("Port must be between 1 and 65535");
  }
  return value;
};
const channel = (value: string): string => {
  if (value !== "stable" && value !== "nightly") {
    throw new Error("Update channel must be stable or nightly");
  }
  return value;
};

const COMMON_FIELDS: Record<string, ConfigField> = {
  "encryption-key": {
    environmentKey: "TOKTRACKER_API_KEY",
    sensitive: true,
  },
  "update-channel": {
    environmentKey: "TOKTRACKER_UPDATE_CHANNEL",
    validate: channel,
  },
};
const CONFIG_FIELDS: Record<ServiceRole, Record<string, ConfigField>> = {
  client: {
    ...COMMON_FIELDS,
    "data-dir": { environmentKey: "TOKTRACKER_DATA_DIR" },
    "device-name": { environmentKey: "TOKTRACKER_DEVICE_NAME" },
    "gateway-url": {
      environmentKey: "TOKTRACKER_GATEWAY",
      validate: normalizeUrl,
    },
    "interval-ms": {
      environmentKey: "TOKTRACKER_INTERVAL_MS",
      validate: positiveInteger,
    },
  },
  gateway: {
    ...COMMON_FIELDS,
    "dashboard-dir": { environmentKey: "TOKTRACKER_DASHBOARD_DIR" },
    database: { environmentKey: "TOKTRACKER_DB" },
    host: { environmentKey: "HOST" },
    port: { environmentKey: "PORT", validate: port },
  },
};

const usage = (role: ServiceRole): never => {
  const executable = `toktracker-${role}`;
  throw new Error(
    [
      "Usage:",
      `  ${executable} setup`,
      `  ${executable} config [list|path]`,
      `  ${executable} config get <name>`,
      `  ${executable} config set <name> <value> [--no-restart]`,
      `  ${executable} config unset <name> [--no-restart]`,
      `  ${executable} update [--nightly|--stable] [--version <tag>] [--force]`,
      `  ${executable} versions`,
      `  ${executable} use <version>`,
      `  ${executable} rollback`,
      `  ${executable} channel <stable|nightly>`,
      ...(role === "gateway"
        ? [
            `  ${executable} auth code`,
            `  ${executable} auth devices`,
            `  ${executable} auth revoke <device-id>`,
          ]
        : []),
    ].join("\n")
  );
};

const fieldFor = (role: ServiceRole, name: string | undefined): ConfigField => {
  const field = name ? CONFIG_FIELDS[role][name] : undefined;
  if (!field) {
    const names = Object.keys(CONFIG_FIELDS[role]).toSorted().join(", ");
    throw new Error(`Unknown config field. Available fields: ${names}`);
  }
  return field;
};

const displayValue = (value: string | undefined, sensitive = false): string => {
  if (value === undefined || value === "") {
    return "(not set)";
  }
  return sensitive ? "********" : value;
};

const validateGateway = async (
  gatewayUrl: string,
  config: Record<string, string>
): Promise<void> => {
  const key = config.TOKTRACKER_API_KEY;
  const response = await fetch(`${gatewayUrl}/api/health`, {
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Gateway check returned HTTP ${response.status}`);
  }
};

const runConfigCommand = async (
  role: ServiceRole,
  args: string[]
): Promise<void> => {
  const [action = "list", name, rawValue, ...flags] = args;
  if (action === "path") {
    console.log(configPath(role));
    return;
  }
  const config = await readConfig(role);
  if (action === "list") {
    console.log(`Config: ${configPath(role)}`);
    for (const [fieldName, field] of Object.entries(
      CONFIG_FIELDS[role]
    ).toSorted(([left], [right]) => left.localeCompare(right))) {
      console.log(
        `${fieldName}=${displayValue(config[field.environmentKey], field.sensitive)}`
      );
    }
    return;
  }
  const field = fieldFor(role, name);
  if (action === "get") {
    console.log(config[field.environmentKey] ?? "");
    return;
  }
  if (action !== "set" && action !== "unset") {
    return usage(role);
  }
  if (action === "set" && rawValue === undefined) {
    throw new Error(`A value is required for ${name}`);
  }
  const value =
    action === "unset"
      ? ""
      : await (field.validate?.(rawValue ?? "", config) ?? rawValue ?? "");
  const commandFlags =
    action === "unset"
      ? [rawValue, ...flags].filter((flag): flag is string => Boolean(flag))
      : flags;
  const updatedConfig = { ...config, [field.environmentKey]: value };
  if (
    role === "client" &&
    name === "gateway-url" &&
    !commandFlags.includes("--skip-check")
  ) {
    await validateGateway(value, updatedConfig);
  }
  await writeConfig(role, updatedConfig);
  console.log(`Updated ${name} in ${configPath(role)}`);
  if (!commandFlags.includes("--no-restart")) {
    restartService(role);
    console.log(`Restarted TokTracker ${role}`);
  }
};

export const runCli = async (role: ServiceRole): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "setup") {
    await setupRole(role);
    return;
  }
  if (command === "complete-install") {
    await migrateLegacyGlobalInstallation(role);
    if (await Bun.file(configPath(role)).exists()) {
      await installService(role);
      if (!restartService(role)) {
        throw new Error(`Could not restart TokTracker ${role}`);
      }
      console.log(
        `Migrated TokTracker ${role} to the versioned installation system`
      );
    } else {
      await setupRole(role);
    }
    return;
  }
  if (command === "run-service") {
    await runService(role);
    return;
  }
  if (command === "config") {
    await runConfigCommand(role, args);
    return;
  }
  if (command === "channel") {
    const [selectedChannel] = args;
    await runConfigCommand(role, [
      "set",
      "update-channel",
      selectedChannel ?? "",
      "--no-restart",
    ]);
    return;
  }
  if (command === "update") {
    const selectedChannel = args.includes("--nightly")
      ? "nightly"
      : args.includes("--stable")
        ? "stable"
        : undefined;
    const versionFlagIndex = args.indexOf("--version");
    const requestedVersion =
      versionFlagIndex === -1 ? undefined : args[versionFlagIndex + 1];
    if (versionFlagIndex !== -1 && !requestedVersion) {
      throw new Error("--version requires a release tag");
    }
    await updateRole(
      role,
      selectedChannel,
      args.includes("--force"),
      requestedVersion
    );
    return;
  }
  if (command === "versions") {
    await listInstalledVersions(role);
    return;
  }
  if (command === "use") {
    const [version] = args;
    if (!version) {
      throw new Error("A version is required");
    }
    await switchInstalledVersion(role, version);
    console.log(`Activated TokTracker ${role} ${version}`);
    return;
  }
  if (command === "rollback") {
    await rollbackRole(role);
    return;
  }
  usage(role);
};
