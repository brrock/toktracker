import { isIP } from "node:net";

import { parseArgs } from "./args";
import {
  installedVersions,
  migrateLegacyGlobalInstallation,
} from "./installation";
import { installService, setupRole } from "./onboard";
import { runService } from "./run-service";
import { configPath, readConfig, writeConfig } from "./runtime-config";
import type { ServiceRole } from "./runtime-config";
import { currentVersion, printStatus } from "./status";
import {
  bold,
  CliError,
  cyan,
  didYouMean,
  dim,
  formatTable,
  printInfo,
  printSuccess,
  printWarning,
  reportError,
  usageError,
} from "./ui";
import {
  listInstalledVersions,
  restartService,
  rollbackRole,
  switchInstalledVersion,
  updateRole,
} from "./update";

interface ConfigField {
  description: string;
  environmentKey: string;
  sensitive?: boolean;
  validate?: (value: string) => string;
}

const normalizeUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("expected a full URL such as http://server:3000");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("the URL must start with http:// or https://");
  }
  return url.toString().replace(/\/$/u, "");
};
const positiveInteger = (value: string): string => {
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error("expected a positive whole number");
  }
  return value;
};
const port = (value: string): string => {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error("expected a port between 1 and 65535");
  }
  return value;
};
const channel = (value: string): string => {
  if (value !== "stable" && value !== "nightly") {
    throw new Error("expected stable or nightly");
  }
  return value;
};
const ON_VALUES = new Set(["1", "on", "true", "yes"]);
const OFF_VALUES = new Set(["0", "off", "false", "no"]);
const boolean = (value: string): string => {
  const normalized = value.toLowerCase();
  if (ON_VALUES.has(normalized)) {
    return "1";
  }
  if (OFF_VALUES.has(normalized)) {
    return "0";
  }
  throw new Error("expected 1/on or 0/off");
};
const bindAddress = (value: string): string => {
  if (isIP(value) === 0) {
    throw new Error("expected an IPv4 or IPv6 address without a port");
  }
  return value;
};
const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address.startsWith("127.");

const COMMON_FIELDS = {
  "encryption-key": {
    description: "Shared key that encrypts and authorizes client uploads",
    environmentKey: "TOKTRACKER_API_KEY",
    sensitive: true,
  },
  "update-channel": {
    description: "Release channel used by update: stable or nightly",
    environmentKey: "TOKTRACKER_UPDATE_CHANNEL",
    validate: channel,
  },
} satisfies Record<string, ConfigField>;
const CONFIG_FIELDS = {
  client: {
    ...COMMON_FIELDS,
    "cursor-dashboard": {
      description: "Export Cursor usage from its dashboard API (1/0)",
      environmentKey: "TOKTRACKER_CURSOR_DASHBOARD",
      validate: boolean,
    },
    "cursor-sync-interval-ms": {
      description: "How often Cursor usage is refreshed, in milliseconds",
      environmentKey: "TOKTRACKER_CURSOR_SYNC_INTERVAL_MS",
      validate: positiveInteger,
    },
    "data-dir": {
      description: "Where the client keeps its local state",
      environmentKey: "TOKTRACKER_DATA_DIR",
    },
    "device-name": {
      description: "Name shown for this machine in the dashboard",
      environmentKey: "TOKTRACKER_DEVICE_NAME",
    },
    "gateway-auto-update": {
      description: "Let the gateway schedule client updates (1/0)",
      environmentKey: "TOKTRACKER_GATEWAY_AUTO_UPDATE",
      validate: boolean,
    },
    "gateway-provider-settings": {
      description: "Let the gateway manage provider settings (1/0)",
      environmentKey: "TOKTRACKER_GATEWAY_PROVIDER_SETTINGS",
      validate: boolean,
    },
    "gateway-url": {
      description: "Gateway this client uploads to",
      environmentKey: "TOKTRACKER_GATEWAY",
      validate: normalizeUrl,
    },
    "interval-ms": {
      description: "How often sessions are scanned, in milliseconds",
      environmentKey: "TOKTRACKER_INTERVAL_MS",
      validate: positiveInteger,
    },
  },
  gateway: {
    ...COMMON_FIELDS,
    "dashboard-dir": {
      description: "Directory with the built dashboard to serve",
      environmentKey: "TOKTRACKER_DASHBOARD_DIR",
    },
    database: {
      description: "Path to the SQLite database",
      environmentKey: "TOKTRACKER_DB",
    },
    host: {
      description: "Bind address (prefer the bind command)",
      environmentKey: "HOST",
    },
    port: {
      description: "Port the gateway and dashboard listen on",
      environmentKey: "PORT",
      validate: port,
    },
  },
} satisfies Record<ServiceRole, Record<string, ConfigField>>;

const ROLE_DESCRIPTIONS = {
  client:
    "Scans local AI coding-agent sessions and uploads usage to your gateway.",
  gateway: "Collects usage from clients and serves the TokTracker dashboard.",
} satisfies Record<ServiceRole, string>;

type CommandGroup =
  | "Cursor accounts"
  | "Dashboard access"
  | "Getting started"
  | "Settings"
  | "Updates";
const GROUP_ORDER: readonly CommandGroup[] = [
  "Getting started",
  "Settings",
  "Updates",
  "Dashboard access",
  "Cursor accounts",
];

interface Command {
  examples?: readonly string[];
  group?: CommandGroup;
  name: string;
  options?: readonly (readonly [string, string])[];
  /** Show the command's help when it is run without arguments. */
  requiresArguments?: boolean;
  roles: readonly ServiceRole[];
  run: (role: ServiceRole, args: string[]) => Promise<void>;
  summary: string;
  /** Argument patterns, without the executable and command name. */
  usage: readonly string[];
}

const BOTH_ROLES: readonly ServiceRole[] = ["client", "gateway"];
const NO_RESTART_OPTION = [
  "--no-restart",
  "Save without restarting the background service",
] as const;

const executableFor = (role: ServiceRole): string => `toktracker-${role}`;

const fieldNames = (role: ServiceRole): string[] =>
  Object.keys(CONFIG_FIELDS[role]).toSorted();

const fieldFor = (role: ServiceRole, name: string | undefined): ConfigField => {
  const fields: Record<string, ConfigField> = CONFIG_FIELDS[role];
  const executable = executableFor(role);
  if (!name) {
    throw usageError(
      "A setting name is required",
      `Run ${bold(`${executable} config`)} to see all settings.`
    );
  }
  const field = fields[name];
  if (!field) {
    const otherRole: ServiceRole = role === "client" ? "gateway" : "client";
    const belongsToOtherRole = fieldNames(otherRole).includes(name);
    throw usageError(
      `Unknown setting "${name}"`,
      belongsToOtherRole
        ? `"${name}" is a ${otherRole} setting. Try ${bold(`${executableFor(otherRole)} config`)}.`
        : (didYouMean(name, fieldNames(role)) ??
            `Available settings: ${fieldNames(role).join(", ")}`)
    );
  }
  return field;
};

const displayValue = (value: string | undefined, sensitive = false): string => {
  if (value === undefined || value === "") {
    return dim("(not set)");
  }
  return sensitive ? "********" : value;
};

const validateGateway = async (
  gatewayUrl: string,
  key: string | undefined
): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}/api/health`, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new CliError(
      `Could not reach a gateway at ${gatewayUrl}`,
      "Check the URL and that the gateway is running, or add --skip-check to save it anyway.",
      1,
      { cause: error }
    );
  }
  if (response.status === 401) {
    throw new CliError(
      "The gateway rejected the encryption key",
      "Set the matching key first: toktracker-client config set encryption-key <key>"
    );
  }
  if (!response.ok) {
    throw new CliError(
      `The gateway health check returned HTTP ${response.status}`
    );
  }
};

const restartAfterChange = (role: ServiceRole): void => {
  if (restartService(role)) {
    printSuccess(`Restarted the TokTracker ${role} service`);
    return;
  }
  printWarning(
    `Saved, but the ${role} service could not be restarted. Check ${executableFor(role)} status.`
  );
};

const setConfigValue = async (
  role: ServiceRole,
  name: string,
  value: string,
  restart: boolean
): Promise<void> => {
  const field = fieldFor(role, name);
  const config = await readConfig(role);
  await writeConfig(role, { ...config, [field.environmentKey]: value });
  const shown =
    value === "" ? "(not set)" : displayValue(value, field.sensitive);
  printSuccess(
    value === "" ? `Unset ${bold(name)}` : `Set ${bold(name)} to ${shown}`
  );
  if (restart) {
    restartAfterChange(role);
  }
};

const validatedValue = (
  field: ConfigField,
  name: string,
  rawValue: string
): string => {
  try {
    return field.validate?.(rawValue) ?? rawValue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError(`Invalid value for ${name}: ${reason}`);
  }
};

const printConfig = async (role: ServiceRole): Promise<void> => {
  const config = await readConfig(role);
  const exists = await Bun.file(configPath(role)).exists();
  console.log(
    `${bold("Config file")} ${configPath(role)}${exists ? "" : dim(" (not created yet)")}\n`
  );
  const fields: Record<string, ConfigField> = CONFIG_FIELDS[role];
  const rows = fieldNames(role).map((fieldName) => {
    const field = fields[fieldName];
    return [
      cyan(fieldName),
      displayValue(
        field ? config[field.environmentKey] : undefined,
        field?.sensitive
      ),
      dim(field?.description ?? ""),
    ];
  });
  console.log(formatTable(rows, "  "));
  console.log(
    dim(
      `\nChange a setting with: ${executableFor(role)} config set <name> <value>`
    )
  );
};

const runConfigCommand = async (
  role: ServiceRole,
  args: string[]
): Promise<void> => {
  const helpCommand = `${executableFor(role)} config`;
  const parsed = parseArgs(
    args,
    { booleans: ["--no-restart", "--skip-check"] },
    helpCommand
  );
  const [action = "list", name, rawValue, ...extra] = parsed.positionals;
  const restart = !parsed.booleans.has("--no-restart");
  const actions = ["get", "list", "path", "set", "unset"];
  if (!actions.includes(action)) {
    throw usageError(
      `Unknown config action "${action}"`,
      didYouMean(action, actions) ?? `Run ${helpCommand} --help for usage.`
    );
  }
  if (action === "path") {
    console.log(configPath(role));
    return;
  }
  if (action === "list") {
    await printConfig(role);
    return;
  }
  const field = fieldFor(role, name);
  if (action === "get") {
    const config = await readConfig(role);
    console.log(config[field.environmentKey] ?? "");
    return;
  }
  if (action === "unset") {
    await setConfigValue(role, name ?? "", "", restart);
    return;
  }
  if (rawValue === undefined) {
    throw usageError(
      `A value is required for ${name}`,
      `Usage: ${helpCommand} set ${name} <value>`
    );
  }
  if (extra.length > 0) {
    throw usageError(
      `Too many arguments for config set: ${extra.join(" ")}`,
      "Quote values that contain spaces."
    );
  }
  const value = validatedValue(field, name ?? "", rawValue);
  if (
    role === "client" &&
    name === "gateway-url" &&
    !parsed.booleans.has("--skip-check")
  ) {
    const config = await readConfig(role);
    await validateGateway(value, config.TOKTRACKER_API_KEY);
  }
  await setConfigValue(role, name ?? "", value, restart);
};

const requireArgument = (
  value: string | undefined,
  what: string,
  role: ServiceRole,
  command: string
): string => {
  if (!value) {
    throw usageError(
      `${what} is required`,
      `Run ${executableFor(role)} ${command} --help for usage.`
    );
  }
  return value;
};

const COMMANDS: readonly Command[] = [
  {
    examples: [""],
    group: "Getting started",
    name: "setup",
    roles: BOTH_ROLES,
    run: (role) => setupRole(role),
    summary: "Configure TokTracker and install the background service",
    usage: [""],
  },
  {
    group: "Getting started",
    name: "status",
    roles: BOTH_ROLES,
    run: async (role) => {
      if (!(await printStatus(role))) {
        process.exitCode = 1;
      }
    },
    summary: "Show the version, service state and connectivity",
    usage: [""],
  },
  {
    examples: ["", "get update-channel", "set update-channel nightly"],
    group: "Settings",
    name: "config",
    options: [
      NO_RESTART_OPTION,
      ["--skip-check", "Save gateway-url without contacting the gateway"],
    ],
    roles: BOTH_ROLES,
    run: runConfigCommand,
    summary: "View or change settings",
    usage: [
      "[list]",
      "path",
      "get <name>",
      "set <name> <value> [--no-restart]",
      "unset <name> [--no-restart]",
    ],
  },
  {
    examples: ["127.0.0.1", "0.0.0.0", "192.168.0.77"],
    group: "Settings",
    name: "bind",
    options: [NO_RESTART_OPTION],
    roles: ["gateway"],
    run: async (role, args) => {
      const parsed = parseArgs(
        args,
        { booleans: ["--no-restart"] },
        `${executableFor(role)} bind`
      );
      const address = requireArgument(
        parsed.positionals[0],
        "A bind address",
        role,
        "bind"
      );
      const bindHost = validatedValue(
        { ...CONFIG_FIELDS.gateway.host, validate: bindAddress },
        "bind address",
        address
      );
      const config = await readConfig(role);
      if (!isLoopbackAddress(bindHost) && !config.TOKTRACKER_API_KEY) {
        throw new CliError(
          "An encryption key is required before binding beyond localhost",
          `Set one first: ${bold("toktracker-gateway config set encryption-key <key>")}`
        );
      }
      await setConfigValue(
        role,
        "host",
        bindHost,
        !parsed.booleans.has("--no-restart")
      );
    },
    summary: "Choose which network address the gateway listens on",
    usage: ["<IPv4-or-IPv6-address> [--no-restart]"],
  },
  {
    examples: ["", "nightly"],
    group: "Updates",
    name: "channel",
    roles: BOTH_ROLES,
    run: async (role, args) => {
      const [selectedChannel] = parseArgs(
        args,
        {},
        `${executableFor(role)} channel`
      ).positionals;
      if (!selectedChannel) {
        const config = await readConfig(role);
        console.log(config.TOKTRACKER_UPDATE_CHANNEL || "stable");
        return;
      }
      const value = validatedValue(
        CONFIG_FIELDS[role]["update-channel"],
        "update-channel",
        selectedChannel
      );
      await setConfigValue(role, "update-channel", value, false);
      printInfo(
        `Run ${bold(`${executableFor(role)} update`)} to install it now.`
      );
    },
    summary: "Show or switch the release channel (stable or nightly)",
    usage: ["[stable|nightly]"],
  },
  {
    examples: ["", "--nightly", "--version v0.1.0"],
    group: "Updates",
    name: "update",
    options: [
      ["--stable", "Use the stable channel for this update"],
      ["--nightly", "Use the nightly channel for this update"],
      ["--version <tag>", "Install a specific release"],
      ["--force", "Reinstall even when already up to date"],
    ],
    roles: BOTH_ROLES,
    run: async (role, args) => {
      const parsed = parseArgs(
        args,
        {
          booleans: ["--force", "--nightly", "--stable"],
          values: ["--version"],
        },
        `${executableFor(role)} update`
      );
      if (parsed.booleans.has("--nightly") && parsed.booleans.has("--stable")) {
        throw usageError("Choose either --nightly or --stable, not both");
      }
      let selectedChannel: "nightly" | "stable" | undefined;
      if (parsed.booleans.has("--nightly")) {
        selectedChannel = "nightly";
      } else if (parsed.booleans.has("--stable")) {
        selectedChannel = "stable";
      }
      await updateRole(
        role,
        selectedChannel,
        parsed.booleans.has("--force"),
        parsed.values.get("--version")
      );
    },
    summary: "Download and install the latest release",
    usage: ["[--stable|--nightly] [--version <tag>] [--force]"],
  },
  {
    group: "Updates",
    name: "versions",
    roles: BOTH_ROLES,
    run: (role) => listInstalledVersions(role),
    summary: "List installed versions",
    usage: [""],
  },
  {
    examples: ["v0.1.0"],
    group: "Updates",
    name: "use",
    roles: BOTH_ROLES,
    run: async (role, args) => {
      const version = requireArgument(
        parseArgs(args, {}, `${executableFor(role)} use`).positionals[0],
        "A version",
        role,
        "use"
      );
      const installed = await installedVersions(role);
      if (!installed.includes(version)) {
        throw new CliError(
          `TokTracker ${role} ${version} is not installed`,
          installed.length > 0
            ? `Installed versions: ${installed.join(", ")}. Install others with ${bold(`${executableFor(role)} update --version ${version}`)}.`
            : `Install it with ${bold(`${executableFor(role)} update --version ${version}`)}.`
        );
      }
      await switchInstalledVersion(role, version);
      printSuccess(`Now running TokTracker ${role} ${bold(version)}`);
    },
    summary: "Switch to an installed version",
    usage: ["<version>"],
  },
  {
    group: "Updates",
    name: "rollback",
    roles: BOTH_ROLES,
    run: (role) => rollbackRole(role),
    summary: "Return to the previously active version",
    usage: [""],
  },
  {
    examples: ["code", "devices", "revoke 3f2a9c"],
    group: "Dashboard access",
    name: "auth",
    roles: ["gateway"],
    run: async (_role, args) => {
      const { runDashboardAuthCommand } = await import("./dashboard-auth");
      await runDashboardAuthCommand(args);
    },
    summary: "Pair browsers with the dashboard and manage them",
    usage: ["code", "devices", "revoke <device-id>"],
  },
  {
    examples: ["login --name work", "accounts", "sync --force"],
    group: "Cursor accounts",
    name: "cursor",
    options: [
      ["--name <label>", "Label for the account (login)"],
      ["--token <token>", "Use a WorkosCursorSessionToken (login)"],
      ["--purge-cache", "Also delete cached usage (logout)"],
      ["--force", "Ignore the cache freshness check (sync)"],
    ],
    requiresArguments: true,
    roles: ["client"],
    run: async (_role, args) => {
      const { runCursorCommand } = await import("./cursor");
      await runCursorCommand(args);
    },
    summary: "Manage Cursor accounts and usage sync",
    usage: [
      "login [--name <label>] [--token <session-token>]",
      "accounts",
      "switch <id-or-name>",
      "logout <id-or-name> [--purge-cache]",
      "sync [--force]",
    ],
  },
  {
    name: "run-service",
    roles: BOTH_ROLES,
    run: (role) => runService(role),
    summary: "Run in the foreground (used by the background service)",
    usage: [""],
  },
  {
    name: "complete-install",
    roles: BOTH_ROLES,
    run: async (role) => {
      await migrateLegacyGlobalInstallation(role);
      if (!(await Bun.file(configPath(role)).exists())) {
        await setupRole(role);
        return;
      }
      await installService(role);
      if (!restartService(role)) {
        throw new CliError(`Could not restart TokTracker ${role}`);
      }
      printSuccess(
        `Migrated TokTracker ${role} to the versioned installation system`
      );
    },
    summary: "Finish an installer run",
    usage: [""],
  },
];

const commandsFor = (role: ServiceRole): Command[] =>
  COMMANDS.filter((command) => command.roles.includes(role));

const visibleCommandsFor = (role: ServiceRole): Command[] =>
  commandsFor(role).filter((command) => command.group !== undefined);

const findCommand = (role: ServiceRole, name: string): Command | undefined =>
  commandsFor(role).find((command) => command.name === name);

const usageLines = (role: ServiceRole, command: Command): string[] =>
  command.usage.map((pattern) =>
    `${executableFor(role)} ${command.name} ${pattern}`.trimEnd()
  );

export const helpText = (role: ServiceRole): string => {
  const executable = executableFor(role);
  const commands = visibleCommandsFor(role);
  const sections = [
    `${bold(`TokTracker ${role}`)} ${dim("-")} ${ROLE_DESCRIPTIONS[role]}`,
    `${bold("Usage")}\n  ${executable} <command> [options]`,
  ];
  for (const group of GROUP_ORDER) {
    const grouped = commands.filter((command) => command.group === group);
    if (grouped.length === 0) {
      continue;
    }
    sections.push(
      `${bold(group)}\n${formatTable(
        grouped.map((command) => [cyan(command.name), command.summary]),
        "  "
      )}`
    );
  }
  sections.push(
    `${bold("Options")}\n${formatTable(
      [
        [cyan("-h, --help"), "Show help for the CLI or a command"],
        [cyan("-v, --version"), "Show the installed version"],
      ],
      "  "
    )}`,
    dim(`Run '${executable} <command> --help' for details on a command.`)
  );
  return sections.join("\n\n");
};

export const commandHelpText = (role: ServiceRole, name: string): string => {
  const command = findCommand(role, name);
  if (!command) {
    return helpText(role);
  }
  const sections = [
    command.summary,
    `${bold("Usage")}\n${usageLines(role, command)
      .map((line) => `  ${line}`)
      .join("\n")}`,
  ];
  if (command.options?.length) {
    sections.push(
      `${bold("Options")}\n${formatTable(
        command.options.map(([flag, description]) => [cyan(flag), description]),
        "  "
      )}`
    );
  }
  if (command.name === "config") {
    sections.push(
      `${bold("Settings")}\n${formatTable(
        Object.entries(CONFIG_FIELDS[role])
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([fieldName, field]) => [cyan(fieldName), field.description]),
        "  "
      )}`
    );
  }
  if (command.examples?.length) {
    sections.push(
      `${bold("Examples")}\n${command.examples
        .map((example) =>
          dim(`  ${executableFor(role)} ${command.name} ${example}`.trimEnd())
        )
        .join("\n")}`
    );
  }
  return sections.join("\n\n");
};

const printCommandHelp = (role: ServiceRole, name: string): void => {
  console.log(commandHelpText(role, name));
};

const isHelpFlag = (value: string | undefined): boolean =>
  value === "--help" || value === "-h";

const dispatch = async (role: ServiceRole, argv: string[]): Promise<void> => {
  const [commandName, ...args] = argv;
  const executable = executableFor(role);
  if (!commandName || isHelpFlag(commandName)) {
    console.log(helpText(role));
    if (!(await Bun.file(configPath(role)).exists())) {
      console.log(
        `\n${cyan("New here?")} Run ${bold(`${executable} setup`)} to get started.`
      );
    }
    return;
  }
  if (
    commandName === "--version" ||
    commandName === "-v" ||
    commandName === "version"
  ) {
    console.log(await currentVersion(role));
    return;
  }
  if (commandName === "help") {
    const [topic] = args;
    console.log(topic ? commandHelpText(role, topic) : helpText(role));
    return;
  }
  const command = findCommand(role, commandName);
  if (!command) {
    const otherRole: ServiceRole = role === "client" ? "gateway" : "client";
    const belongsToOtherRole = findCommand(otherRole, commandName);
    const suggestion = didYouMean(
      commandName,
      visibleCommandsFor(role).map((candidate) => candidate.name)
    );
    throw usageError(
      `Unknown command "${commandName}"`,
      belongsToOtherRole
        ? `"${commandName}" is a ${otherRole} command. Try ${bold(`${executableFor(otherRole)} ${commandName}`)}.`
        : (suggestion ??
            `Run ${bold(`${executable} --help`)} to see all commands.`)
    );
  }
  if (
    args.some(isHelpFlag) ||
    (command.requiresArguments && args.length === 0)
  ) {
    printCommandHelp(role, command.name);
    return;
  }
  await command.run(role, args);
};

export const runCli = async (role: ServiceRole): Promise<void> => {
  try {
    await dispatch(role, process.argv.slice(2));
  } catch (error) {
    process.exitCode = reportError(
      error instanceof Error ? error : new Error(String(error))
    );
  }
};
