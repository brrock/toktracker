/* eslint-disable unicorn/import-style, vitest/prefer-importing-vitest-globals */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LAYOUTS,
  isWidgetSupported,
  moveWidget,
  parseLayout,
  uniqueWidgetId,
  widgetTemplates,
} from "../src/lib/layout.ts";
import type { ViewCapabilities, Widget } from "../src/lib/layout.ts";

const OVERVIEW = DEFAULT_LAYOUTS.overview;
const ids = (widgets: Widget[]): string[] => widgets.map((widget) => widget.id);

describe("parseLayout", () => {
  test("falls back to the view's default layout", () => {
    expect(parseLayout(null, "overview")).toEqual(OVERVIEW);
    expect(parseLayout("{broken", "overview")).toEqual(OVERVIEW);
    expect(parseLayout(JSON.stringify({ version: 9 }), "overview")).toEqual(
      OVERVIEW
    );
  });

  test("keeps a stored order and drops duplicate ids", () => {
    const [stats, timeline] = OVERVIEW;
    const stored = JSON.stringify({
      version: 1,
      widgets: [timeline, stats, timeline],
    });
    expect(ids(parseLayout(stored, "overview"))).toEqual([
      "spend-over-time",
      "stats",
    ]);
  });

  test("rejects layouts containing unknown widget kinds", () => {
    const stored = JSON.stringify({
      version: 1,
      widgets: [{ id: "x", kind: "pie-in-the-sky", size: "sm" }],
    });
    expect(parseLayout(stored, "overview")).toEqual(OVERVIEW);
  });
});

describe("moveWidget", () => {
  test("moves a widget into its target's position", () => {
    expect(ids(moveWidget(OVERVIEW, "recent-sessions", "stats"))).toEqual([
      "recent-sessions",
      "stats",
      "spend-over-time",
      "by-model",
      "by-agent",
      "by-project",
    ]);
    expect(ids(moveWidget(OVERVIEW, "stats", "by-model"))).toEqual([
      "spend-over-time",
      "by-model",
      "stats",
      "by-agent",
      "by-project",
      "recent-sessions",
    ]);
  });

  test("ignores unknown ids", () => {
    expect(moveWidget(OVERVIEW, "nope", "stats")).toBe(OVERVIEW);
  });
});

describe("capabilities", () => {
  const agentView: ViewCapabilities = {
    dimensions: ["model", "project"],
    queries: false,
    sessions: false,
    slots: [],
    stats: true,
    timeline: true,
  };

  test("hides widgets whose data the view does not have", () => {
    const byAgent = OVERVIEW.find((widget) => widget.id === "by-agent");
    const byModel = OVERVIEW.find((widget) => widget.id === "by-model");
    expect(byAgent && isWidgetSupported(byAgent, agentView)).toBe(false);
    expect(byModel && isWidgetSupported(byModel, agentView)).toBe(true);
  });

  test("offers templates only for available data", () => {
    const labels = widgetTemplates(agentView).map((template) => template.label);
    expect(labels).toContain("Usage by model");
    expect(labels).not.toContain("Usage by coding agent");
    expect(labels).not.toContain("Recent sessions");
  });
});

test("uniqueWidgetId appends a counter", () => {
  expect(uniqueWidgetId(OVERVIEW, "custom-chart")).toBe("custom-chart");
  expect(uniqueWidgetId(OVERVIEW, "stats")).toBe("stats-2");
});
