import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

const { join } = path;

export type ServiceRole = "client" | "gateway";

export const applicationRoot = (): string =>
  process.env.TOKTRACKER_RUNTIME_ROOT ??
  path.resolve(import.meta.dirname, "..", "..", "..");

const applicationDirectory = (): string => {
  const home = homedir();
  if (platform() === "win32") {
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "TokTracker"
    );
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "TokTracker");
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    "toktracker"
  );
};

export const configPath = (role: ServiceRole): string =>
  join(applicationDirectory(), `${role}.env`);

export const dataDirectory = (role: ServiceRole): string => {
  const home = homedir();
  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "TokTracker",
      role
    );
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "TokTracker", role);
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
    "toktracker",
    role
  );
};

export const writeConfig = async (
  role: ServiceRole,
  values: Record<string, string>
): Promise<string> => {
  const destination = configPath(role);
  await mkdir(applicationDirectory(), { recursive: true });
  await mkdir(dataDirectory(role), { recursive: true });
  const contents = Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
  await Bun.write(destination, `${contents}\n`);
  if (platform() !== "win32") {
    await chmod(destination, 0o600);
  }
  return destination;
};

export const readConfig = async (
  role: ServiceRole
): Promise<Record<string, string>> => {
  const file = Bun.file(configPath(role));
  if (!(await file.exists())) {
    return {};
  }
  const values: Record<string, string> = {};
  const contents = await file.text();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator);
    const serializedValue = line.slice(separator + 1);
    try {
      values[key] = JSON.parse(serializedValue) as string;
    } catch {
      values[key] = serializedValue;
    }
  }
  return values;
};

export const loadConfig = async (role: ServiceRole): Promise<void> => {
  const values = await readConfig(role);
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
};
