/* eslint-disable vitest/prefer-importing-vitest-globals */
import { afterEach, expect, spyOn, test } from "bun:test";

import { runCli } from "../src/cli";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

test("prints help when invoked without a command", async () => {
  process.argv = ["bun", "toktracker-gateway"];
  const log = spyOn(console, "log").mockReturnValue();

  await runCli("gateway");

  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Usage:\n  toktracker-gateway setup")
  );
  log.mockRestore();
});

test("client help lists Cursor account commands", async () => {
  process.argv = ["bun", "toktracker-client"];
  const log = spyOn(console, "log").mockReturnValue();

  await runCli("client");

  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("toktracker-client cursor login")
  );
  log.mockRestore();
});
