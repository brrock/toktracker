/* eslint-disable vitest/prefer-importing-vitest-globals */
import { afterEach, expect, spyOn, test } from "bun:test";

import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { closestMatch, formatTable } from "../src/ui";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode ?? 0;
});

const captureOutput = async (
  role: "client" | "gateway",
  args: string[]
): Promise<{
  exitCode: number | string | undefined;
  stderr: string;
  stdout: string;
}> => {
  process.argv = ["bun", `toktracker-${role}`, ...args];
  const log = spyOn(console, "log").mockReturnValue();
  const error = spyOn(console, "error").mockReturnValue();
  try {
    await runCli(role);
    return {
      exitCode: process.exitCode,
      stderr: error.mock.calls.map((call) => call.join(" ")).join("\n"),
      stdout: log.mock.calls.map((call) => call.join(" ")).join("\n"),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
};

test("prints grouped help when invoked without a command", async () => {
  const { stdout } = await captureOutput("gateway", []);

  expect(stdout).toContain("toktracker-gateway <command> [options]");
  expect(stdout).toContain("Getting started");
  expect(stdout).toMatch(/setup\s+Configure TokTracker/u);
  expect(stdout).not.toContain("run-service");
});

test("client help lists Cursor account commands", async () => {
  const { stdout } = await captureOutput("client", ["cursor", "--help"]);

  expect(stdout).toContain("toktracker-client cursor login");
});

test("gateway help hides client-only commands", async () => {
  const { stdout } = await captureOutput("gateway", ["--help"]);

  expect(stdout).not.toMatch(/^\s+cursor\s/mu);
  expect(stdout).toMatch(/^\s+auth\s/mu);
});

test("unknown commands suggest the closest match and exit with usage status", async () => {
  const { exitCode, stderr } = await captureOutput("gateway", ["staus"]);

  expect(exitCode).toBe(2);
  expect(stderr).toContain('Unknown command "staus"');
  expect(stderr).toContain("Did you mean status?");
  expect(stderr).not.toContain("    at ");
});

test("commands for the other role point at the right executable", async () => {
  const { stderr } = await captureOutput("gateway", ["cursor", "accounts"]);

  expect(stderr).toContain("toktracker-client cursor");
});

test("unknown options are rejected with a suggestion", async () => {
  const { exitCode, stderr } = await captureOutput("client", [
    "update",
    "--nightl",
  ]);

  expect(exitCode).toBe(2);
  expect(stderr).toContain("Unknown option --nightl");
  expect(stderr).toContain("Did you mean --nightly?");
});

test("parseArgs separates positionals, booleans and values", () => {
  const parsed = parseArgs(
    ["set", "port", "--no-restart", "--name=work", "--token", "abc"],
    { booleans: ["--no-restart"], values: ["--name", "--token"] },
    "toktracker-client"
  );

  expect(parsed.positionals).toEqual(["set", "port"]);
  expect(parsed.booleans.has("--no-restart")).toBe(true);
  expect(parsed.values.get("--name")).toBe("work");
  expect(parsed.values.get("--token")).toBe("abc");
});

test("parseArgs requires values for value flags", () => {
  expect(() =>
    parseArgs(["--version"], { values: ["--version"] }, "toktracker-client")
  ).toThrow("--version requires a value");
});

test("closestMatch only suggests plausible typos", () => {
  expect(closestMatch("gateway-ur", ["gateway-url", "interval-ms"])).toBe(
    "gateway-url"
  );
  expect(closestMatch("upd", ["update", "use"])).toBe("update");
  expect(closestMatch("zzzzzz", ["update", "use"])).toBeUndefined();
});

test("formatTable aligns columns", () => {
  expect(
    formatTable([
      ["a", "one", "x"],
      ["long", "2", "y"],
    ])
  ).toBe("a     one  x\nlong  2    y");
});
