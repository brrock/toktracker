/* eslint-disable unicorn/import-style, vitest/prefer-importing-vitest-globals */
import { describe, expect, test } from "bun:test";

import { parseSettingsPath } from "../src/lib/settings-path.ts";

describe("parseSettingsPath", () => {
  test("keeps agent pages out of settings", () => {
    expect(parseSettingsPath("/agents/cursor")).toEqual({
      isSettingsPath: false,
      section: undefined,
      settingsOpen: false,
    });
  });

  test("opens Cursor settings only under /settings/cursor", () => {
    expect(parseSettingsPath("/settings/cursor")).toEqual({
      isSettingsPath: true,
      section: "cursor",
      settingsOpen: true,
    });
  });

  test("treats /settings as settings without a section", () => {
    expect(parseSettingsPath("/settings")).toEqual({
      isSettingsPath: true,
      section: undefined,
      settingsOpen: true,
    });
  });
});
