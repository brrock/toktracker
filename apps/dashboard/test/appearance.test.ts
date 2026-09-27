/* eslint-disable unicorn/import-style, vitest/prefer-importing-vitest-globals */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_APPEARANCE,
  greeting,
  parseAppearance,
  rootState,
} from "../src/lib/appearance.ts";
import { relativeTime } from "../src/lib/dashboard.ts";

describe("parseAppearance", () => {
  test("uses the defaults when nothing is stored", () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  test("keeps the colour mode saved by earlier releases", () => {
    expect(parseAppearance(null, "dark")).toEqual({
      ...DEFAULT_APPEARANCE,
      mode: "dark",
    });
  });

  test("merges stored preferences over the defaults", () => {
    const stored = JSON.stringify({ accent: "ocean", font: "editorial" });
    expect(parseAppearance(stored)).toEqual({
      ...DEFAULT_APPEARANCE,
      accent: "ocean",
      font: "editorial",
    });
  });

  test("ignores corrupt or unknown values", () => {
    expect(parseAppearance("{not json")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(JSON.stringify({ font: "comic-sans" }))).toEqual(
      DEFAULT_APPEARANCE
    );
  });
});

describe("rootState", () => {
  test("maps a custom accent to its hue", () => {
    const state = rootState({
      ...DEFAULT_APPEARANCE,
      accent: "custom",
      customHue: 123,
      radius: "round",
    });
    expect(state.properties["--accent-h"]).toBe("123");
    expect(state.properties["--radius"]).toBe("1rem");
    expect(state.attributes["data-font"]).toBe("geist");
  });
});

describe("greeting", () => {
  test("greets by time of day and name", () => {
    expect(greeting(new Date(2026, 0, 1, 9), "")).toBe("Good morning");
    expect(greeting(new Date(2026, 0, 1, 14), " Sam ")).toBe(
      "Good afternoon, Sam"
    );
    expect(greeting(new Date(2026, 0, 1, 21), "")).toBe("Good evening");
  });
});

describe("relativeTime", () => {
  test("describes recent timestamps", () => {
    const now = Date.UTC(2026, 0, 10);
    expect(relativeTime(now - 3 * 60 * 60 * 1000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 1000, now)).toBe("just now");
    expect(relativeTime(0, now)).toBe("Unknown");
  });
});
