import { cp, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "apps", "dashboard", "dist");
const destination = path.join(root, "apps", "gateway", "dist", "dashboard");
if (!(await Bun.file(path.join(source, "index.html")).exists())) {
  throw new Error(
    "Dashboard is not built. Run `bun run build:dashboard` first."
  );
}
await rm(destination, { force: true, recursive: true });
await cp(source, destination, { recursive: true });
console.log(`Copied dashboard into ${destination}`);
