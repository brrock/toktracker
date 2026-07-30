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
