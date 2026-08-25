import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [archiveValue] = process.argv.slice(2);
if (!archiveValue) {
  throw new Error("Usage: bun scripts/verify-release-archive.ts <archive.tgz>");
}

const archive = path.resolve(archiveValue);
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "toktracker-release-verify-")
);
const packageRoot = path.join(temporaryRoot, "package");
const gatewayRoot = path.join(packageRoot, "apps", "gateway", "dist");
const dashboardRoot = path.join(gatewayRoot, "dashboard");

const assertFile = async (filePath: string): Promise<void> => {
  if (!(await Bun.file(filePath).exists())) {
    throw new Error(`Release archive is missing ${filePath}`);
  }
};

const reservePort = (): number => 40_000 + Math.floor(Math.random() * 10_000);

const waitForSettingsApi = async (
  settingsUrl: string,
  remainingAttempts = 50
): Promise<Response | undefined> => {
  try {
    const response = await fetch(settingsUrl);
    if (response.ok) {
      return response;
    }
  } catch {
    // The gateway is still starting.
  }
  if (remainingAttempts === 0) {
    return undefined;
  }
  await Bun.sleep(100);
  return waitForSettingsApi(settingsUrl, remainingAttempts - 1);
};

try {
  const extracted = Bun.spawnSync([
    "tar",
    "-xzf",
    archive,
    "-C",
    temporaryRoot,
  ]);
  if (extracted.exitCode !== 0) {
    throw new Error("Could not extract release archive");
  }

  await assertFile(path.join(gatewayRoot, "cli.js"));
  await assertFile(path.join(gatewayRoot, "index.js"));
  await assertFile(path.join(dashboardRoot, "index.html"));

  const dashboardHtml = await readFile(
    path.join(dashboardRoot, "index.html"),
    "utf-8"
  );
  const dashboardScript = dashboardHtml.match(/src="(?<script>[^"?]+\.js)"/u)
    ?.groups?.script;
  if (!dashboardScript) {
    throw new Error("Dashboard index does not reference a JavaScript bundle");
  }
  const dashboardBundle = await readFile(
    path.join(dashboardRoot, dashboardScript.replace(/^\//u, "")),
    "utf-8"
  );
  if (!dashboardBundle.includes("/settings/general")) {
    throw new Error("Dashboard bundle does not include the Settings route");
  }

  const port = reservePort();
  const gateway = Bun.spawn({
    cmd: [process.execPath, path.join(gatewayRoot, "index.js")],
    cwd: packageRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TOKTRACKER_DB: path.join(temporaryRoot, "toktracker.db"),
      TOKTRACKER_DISABLE_DASHBOARD_AUTH: "1",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  try {
    const settingsUrl = `http://127.0.0.1:${port}/api/v1/settings/client-auto-update`;
    const response = await waitForSettingsApi(settingsUrl);
    if (!response?.ok) {
      const [stdout, stderr] = await Promise.all([
        new Response(gateway.stdout).text(),
        new Response(gateway.stderr).text(),
      ]);
      throw new Error(
        `Gateway Settings API did not start successfully: ${stdout}${stderr}`
      );
    }
  } finally {
    gateway.kill();
    await gateway.exited;
  }

  console.log(`Verified ${archive}`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
