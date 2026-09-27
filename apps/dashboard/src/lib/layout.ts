import { z } from "zod";

import { writeStorage } from "@/lib/appearance";
import { QUERY_LIMITS } from "@/lib/query/contract";

const LAYOUT_STORAGE_PREFIX = "toktracker-layout:";
export const LAYOUT_CHANGE_EVENT = "toktracker-layout-change";

export const VIEW_IDS = [
  "overview",
  "agents",
  "agent",
  "projects",
  "project",
  "model",
  "sessions",
  "session",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const WIDGET_SIZES = [
  { id: "sm", label: "S" },
  { id: "md", label: "M" },
  { id: "lg", label: "L" },
  { id: "full", label: "Full" },
] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number]["id"];

export const DIMENSIONS = [
  { id: "agent", label: "Coding agent" },
  { id: "model", label: "Model" },
  { id: "project", label: "Project" },
] as const;
export type Dimension = (typeof DIMENSIONS)[number]["id"];

export const TIMELINE_STYLES = [
  { id: "bar", label: "Bars" },
  { id: "area", label: "Area" },
  { id: "line", label: "Line" },
] as const;
export const RESULT_DISPLAYS = [
  { id: "table", label: "Table" },
  { id: "bar", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "donut", label: "Donut" },
  { id: "stat", label: "Number" },
] as const;
export const VALUE_FORMATS = [
  { id: "auto", label: "Auto" },
  { id: "number", label: "1,234" },
  { id: "compact", label: "1.2K" },
  { id: "currency", label: "$" },
  { id: "percent", label: "%" },
] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number]["id"];
export const BREAKDOWN_STYLES = [
  { id: "bars", label: "Bars" },
  { id: "donut", label: "Donut" },
  { id: "columns", label: "Columns" },
] as const;
export type TimelineStyle = (typeof TIMELINE_STYLES)[number]["id"];
export type BreakdownStyle = (typeof BREAKDOWN_STYLES)[number]["id"];

// View-specific widgets whose content is supplied by the page itself.
export const SLOT_IDS = [
  "agent-cards",
  "project-cards",
  "session-parts",
  "sessions-table",
] as const;
export type SlotId = (typeof SLOT_IDS)[number];
export const SLOT_LABELS = {
  "agent-cards": "Agent cards",
  "project-cards": "Project cards",
  "session-parts": "Model usage table",
  "sessions-table": "Sessions table",
} as const satisfies Record<SlotId, string>;

const metricSchema = z.enum(["cost", "tokens"]);
const sizeSchema = z.enum(["sm", "md", "lg", "full"]);
const baseWidget = {
  id: z.string().min(1).max(64),
  size: sizeSchema,
  title: z.string().max(80).optional(),
};

export const widgetSchema = z.discriminatedUnion("kind", [
  z.object({ ...baseWidget, kind: z.literal("stats") }),
  z.object({ ...baseWidget, kind: z.literal("sessions") }),
  z.object({
    ...baseWidget,
    kind: z.literal("timeline"),
    metric: metricSchema,
    style: z.enum(["bar", "area", "line"]),
  }),
  z.object({
    ...baseWidget,
    dimension: z.enum(["agent", "model", "project"]),
    kind: z.literal("breakdown"),
    metric: metricSchema,
    style: z.enum(["bars", "donut", "columns"]),
  }),
  z.object({
    ...baseWidget,
    code: z.string().max(QUERY_LIMITS.codeLength),
    display: z.enum(["table", "bar", "line", "area", "donut", "stat"]),
    format: z.enum(["auto", "number", "compact", "currency", "percent"]),
    kind: z.literal("query"),
    language: z.enum(["sql", "typescript", "javascript"]),
  }),
  z.object({
    ...baseWidget,
    kind: z.literal("slot"),
    slot: z.enum(SLOT_IDS),
  }),
]);
export type Widget = z.infer<typeof widgetSchema>;
export type WidgetKind = Widget["kind"];
type DraftOf<T extends Widget> = T extends Widget ? Omit<T, "id"> : never;
/** A widget that has not been given an id yet. */
export type WidgetDraft = DraftOf<Widget>;

const MAX_WIDGETS = 40;
const storedLayoutSchema = z.object({
  version: z.literal(1),
  widgets: z.array(widgetSchema).max(MAX_WIDGETS),
});

/** What a view can render; widgets needing anything else are dropped. */
export interface ViewCapabilities {
  dimensions: readonly Dimension[];
  queries: boolean;
  sessions: boolean;
  slots: readonly SlotId[];
  stats: boolean;
  timeline: boolean;
}

export const isWidgetSupported = (
  widget: Widget,
  capabilities: ViewCapabilities
): boolean => {
  switch (widget.kind) {
    case "stats": {
      return capabilities.stats;
    }
    case "sessions": {
      return capabilities.sessions;
    }
    case "timeline": {
      return capabilities.timeline;
    }
    case "breakdown": {
      return capabilities.dimensions.includes(widget.dimension);
    }
    case "slot": {
      return capabilities.slots.includes(widget.slot);
    }
    case "query": {
      return capabilities.queries;
    }
    default: {
      return false;
    }
  }
};

const breakdown = (
  dimension: Dimension,
  size: WidgetSize,
  metric: "cost" | "tokens" = "tokens"
): Widget => ({
  dimension,
  id: `by-${dimension}`,
  kind: "breakdown",
  metric,
  size,
  style: "bars",
});
const STATS: Widget = { id: "stats", kind: "stats", size: "full" };
const SPEND_TIMELINE = (size: WidgetSize): Widget => ({
  id: "spend-over-time",
  kind: "timeline",
  metric: "cost",
  size,
  style: "bar",
});
const slot = (id: SlotId): Widget => ({
  id,
  kind: "slot",
  size: "full",
  slot: id,
});

export const DEFAULT_LAYOUTS = {
  agent: [
    STATS,
    SPEND_TIMELINE("md"),
    breakdown("model", "md"),
    breakdown("project", "md"),
  ],
  agents: [breakdown("agent", "full"), slot("agent-cards")],
  model: [
    STATS,
    SPEND_TIMELINE("md"),
    breakdown("agent", "md"),
    breakdown("project", "md"),
  ],
  overview: [
    STATS,
    SPEND_TIMELINE("lg"),
    breakdown("model", "sm"),
    breakdown("agent", "md"),
    breakdown("project", "md"),
    { id: "recent-sessions", kind: "sessions", size: "full" },
  ],
  project: [
    STATS,
    SPEND_TIMELINE("md"),
    breakdown("agent", "md"),
    breakdown("model", "md"),
    { id: "project-sessions", kind: "sessions", size: "full" },
  ],
  projects: [breakdown("project", "full"), slot("project-cards")],
  session: [STATS, slot("session-parts")],
  sessions: [slot("sessions-table")],
} satisfies Record<ViewId, Widget[]>;

/** Built-in widgets that can be added back to a view, keyed by id. */
export const widgetTemplates = (
  capabilities: ViewCapabilities
): { label: string; widget: Widget }[] => {
  const templates: { label: string; widget: Widget }[] = [];
  if (capabilities.stats) {
    templates.push({ label: "Stat tiles", widget: STATS });
  }
  if (capabilities.timeline) {
    templates.push(
      { label: "Spend over time", widget: SPEND_TIMELINE("lg") },
      {
        label: "Tokens over time",
        widget: {
          id: "tokens-over-time",
          kind: "timeline",
          metric: "tokens",
          size: "lg",
          style: "area",
        },
      }
    );
  }
  for (const dimension of capabilities.dimensions) {
    const label = DIMENSIONS.find((item) => item.id === dimension)?.label;
    templates.push({
      label: `Usage by ${label?.toLowerCase() ?? dimension}`,
      widget: breakdown(dimension, "md"),
    });
  }
  if (capabilities.sessions) {
    templates.push({
      label: "Recent sessions",
      widget: { id: "recent-sessions", kind: "sessions", size: "full" },
    });
  }
  for (const slotId of capabilities.slots) {
    templates.push({ label: SLOT_LABELS[slotId], widget: slot(slotId) });
  }
  return templates;
};

export const parseLayout = (raw: string | null, view: ViewId): Widget[] => {
  const fallback = DEFAULT_LAYOUTS[view];
  if (!raw) {
    return fallback;
  }
  try {
    const stored = storedLayoutSchema.safeParse(JSON.parse(raw));
    if (!stored.success) {
      return fallback;
    }
    const seen = new Set<string>();
    return stored.data.widgets.filter((widget) => {
      const duplicate = seen.has(widget.id);
      seen.add(widget.id);
      return !duplicate;
    });
  } catch {
    return fallback;
  }
};

export const layoutStorageKey = (view: ViewId): string =>
  `${LAYOUT_STORAGE_PREFIX}${view}`;

export const readLayout = (view: ViewId): string | null => {
  try {
    return window.localStorage.getItem(layoutStorageKey(view));
  } catch {
    return null;
  }
};

export const saveLayout = (view: ViewId, widgets: Widget[]): void => {
  writeStorage(layoutStorageKey(view), JSON.stringify({ version: 1, widgets }));
};

export const resetAllLayouts = (): void => {
  try {
    for (const view of VIEW_IDS) {
      window.localStorage.removeItem(layoutStorageKey(view));
    }
  } catch {
    // Nothing stored when storage is unavailable.
  }
  window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
};

/** Moves a widget into the position currently held by `targetId`. */
export const moveWidget = (
  widgets: Widget[],
  id: string,
  targetId: string
): Widget[] => {
  const moved = widgets.find((widget) => widget.id === id);
  const targetIndex = widgets.findIndex((widget) => widget.id === targetId);
  if (!moved || targetIndex === -1 || id === targetId) {
    return widgets;
  }
  const next = widgets.filter((widget) => widget.id !== id);
  next.splice(targetIndex, 0, moved);
  return next;
};

export const uniqueWidgetId = (widgets: Widget[], base: string): string => {
  const ids = new Set(widgets.map((widget) => widget.id));
  if (!ids.has(base)) {
    return base;
  }
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
};
