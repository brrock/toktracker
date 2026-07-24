import path from "node:path";

import { applicationRoot, loadConfig } from "./runtime-config";
import type { ServiceRole } from "./runtime-config";

const sourceEntrypoint = (root: string, role: ServiceRole): string =>
  path.join(root, "apps", role, "src", "index.ts");

export const runService = async (role: ServiceRole): Promise<void> => {
  await loadConfig(role);
  const root = applicationRoot();
  const builtEntrypoint = path.join(root, "apps", role, "dist", "index.js");
  const entrypoint = (await Bun.file(builtEntrypoint).exists())
    ? builtEntrypoint
    : sourceEntrypoint(root, role);
  const child = Bun.spawn([process.execPath, "run", entrypoint], {
    cwd: root,
    env: process.env,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  process.on("SIGINT", () => child.kill());
  process.on("SIGTERM", () => child.kill());
  process.exitCode = await child.exited;
};
