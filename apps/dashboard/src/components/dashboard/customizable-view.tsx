import { Popover } from "@base-ui/react/popover";
import type { SessionSummary, TimeRange } from "@toktracker/shared";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  GripVertical,
  LayoutGrid,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BREAKDOWN_STYLES,
  DEFAULT_LAYOUTS,
  DIMENSIONS,
  isWidgetSupported,
  LAYOUT_CHANGE_EVENT,
  moveWidget,
  parseLayout,
  RESULT_DISPLAYS,
  readLayout,
  saveLayout,
  SLOT_IDS,
  SLOT_LABELS,
  TIMELINE_STYLES,
  uniqueWidgetId,
  VALUE_FORMATS,
  WIDGET_SIZES,
  widgetTemplates,
} from "@/lib/layout";
import type {
  Dimension,
  SlotId,
  ViewCapabilities,
  ViewId,
  Widget,
  WidgetDraft,
  WidgetSize,
} from "@/lib/layout";
import { STARTER_CODE } from "@/lib/query/contract";
import type { Tables } from "@/lib/query/contract";
import { buildTables } from "@/lib/query/dataset";
import type { QuerySource } from "@/lib/query/dataset";
import { cn } from "@/lib/utils";

import { DailySpendChart, UsageBreakdownChart } from "./charts";
import type { ChartMetric } from "./charts";
import { METRIC_OPTIONS, SegmentedControl, Skeleton } from "./primitives";
import type { QueryDraft } from "./query/query-editor";
import { SessionTable } from "./session-table";

// Query widgets and their editor load on demand, so views without queries
// do not download them.
const QueryWidget = lazy(async () => {
  const module = await import("./query/query-widget");
  return { default: module.QueryWidget };
});
const QueryEditorDialog = lazy(async () => {
  const module = await import("./query/query-editor");
  return { default: module.QueryEditorDialog };
});

const EMPTY_TABLES: Tables = {};
const NEW_QUERY: QueryDraft = {
  code: STARTER_CODE.sql,
  display: "bar",
  format: "auto",
  language: "sql",
  title: "",
};

interface BreakdownEntry {
  cost: number;
  name: string;
  tokens: number;
}

/** Everything a view can offer its widgets. Omitted data hides widgets. */
export interface ViewData {
  breakdowns: Partial<Record<Dimension, BreakdownEntry[]>>;
  daily?: { cost: number; date: string; tokens: number }[];
  hourly?: { cost: number; date: string; tokens: number }[];
  periodLabel: string;
  range?: TimeRange;
  sessions?: SessionSummary[];
  sessionsTitle?: string;
  /** Data exposed to query widgets; omit to disable them on a view. */
  query?: QuerySource;
  slots?: Partial<Record<SlotId, React.ReactNode>>;
  stats?: React.ReactNode;
}

const SIZE_CLASSES = {
  full: "col-span-12",
  lg: "col-span-12 xl:col-span-8",
  md: "col-span-12 lg:col-span-6",
  sm: "col-span-12 md:col-span-6 xl:col-span-4",
} as const satisfies Record<WidgetSize, string>;

const capabilitiesOf = (data: ViewData): ViewCapabilities => ({
  dimensions: DIMENSIONS.map((item) => item.id).filter(
    (dimension) => data.breakdowns[dimension] !== undefined
  ),
  queries: data.query !== undefined,
  sessions: data.sessions !== undefined,
  slots: SLOT_IDS.filter((slot) => data.slots?.[slot] !== undefined),
  stats: data.stats !== undefined,
  timeline: data.daily !== undefined,
});

const dimensionLabel = (dimension: Dimension): string =>
  DIMENSIONS.find((item) => item.id === dimension)?.label.toLowerCase() ??
  dimension;

export const widgetTitle = (widget: Widget, data?: ViewData): string => {
  if (widget.title) {
    return widget.title;
  }
  switch (widget.kind) {
    case "timeline": {
      return widget.metric === "cost" ? "Spend over time" : "Tokens over time";
    }
    case "breakdown": {
      return `Usage by ${dimensionLabel(widget.dimension)}`;
    }
    case "sessions": {
      return data?.sessionsTitle ?? "Recent sessions";
    }
    case "stats": {
      return "Stat tiles";
    }
    case "slot": {
      return SLOT_LABELS[widget.slot];
    }
    case "query": {
      return "Query";
    }
    default: {
      return "Widget";
    }
  }
};

const useViewLayout = (
  view: ViewId
): [Widget[], (update: (widgets: Widget[]) => Widget[]) => void] => {
  const [widgets, setWidgets] = useState(() =>
    parseLayout(readLayout(view), view)
  );
  useEffect(() => {
    const reload = (): void => setWidgets(parseLayout(readLayout(view), view));
    window.addEventListener(LAYOUT_CHANGE_EVENT, reload);
    return () => window.removeEventListener(LAYOUT_CHANGE_EVENT, reload);
  }, [view]);
  const change = useCallback(
    (update: (current: Widget[]) => Widget[]): void => {
      setWidgets((current) => {
        const next = update(current);
        saveLayout(view, next);
        return next;
      });
    },
    [view]
  );
  return [widgets, change];
};

const WidgetContent = ({
  data,
  onChange,
  queryTables,
  widget,
}: {
  data: ViewData;
  onChange: (changes: Partial<Widget>) => void;
  queryTables: Tables;
  widget: Widget;
}) => {
  const setMetric = (metric: ChartMetric): void => onChange({ metric });
  switch (widget.kind) {
    case "stats": {
      return data.stats;
    }
    case "timeline": {
      return (
        <DailySpendChart
          daily={data.daily ?? []}
          hourly={data.hourly}
          metric={widget.metric}
          onMetricChange={setMetric}
          periodLabel={data.periodLabel}
          range={data.range}
          title={widgetTitle(widget, data)}
          variant={widget.style}
        />
      );
    }
    case "breakdown": {
      return (
        <UsageBreakdownChart
          entries={data.breakdowns[widget.dimension] ?? []}
          kind={widget.dimension}
          metric={widget.metric}
          onMetricChange={setMetric}
          periodLabel={data.periodLabel}
          title={widgetTitle(widget, data)}
          variant={widget.style}
        />
      );
    }
    case "sessions": {
      return (
        <SessionTable
          sessions={data.sessions ?? []}
          title={widgetTitle(widget, data)}
        />
      );
    }
    case "slot": {
      return data.slots?.[widget.slot] ?? null;
    }
    case "query": {
      return (
        <Suspense fallback={<Skeleton className="h-72 rounded-xl" />}>
          <QueryWidget
            widget={widget}
            tables={queryTables}
            onChange={(draft) => onChange(draft)}
          />
        </Suspense>
      );
    }
    default: {
      return null;
    }
  }
};

const Field = ({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) => (
  <div className="space-y-1.5">
    <p className="text-xs font-medium text-muted-foreground">{label}</p>
    {children}
  </div>
);

const ChartOptions = ({
  onChange,
  widget,
}: {
  onChange: (changes: Partial<Widget>) => void;
  widget: Widget;
}) => {
  if (widget.kind === "timeline") {
    return (
      <>
        <Field label="Chart type">
          <SegmentedControl
            label="Chart type"
            options={TIMELINE_STYLES.map((style) => ({
              label: style.label,
              value: style.id,
            }))}
            value={widget.style}
            onChange={(style) => onChange({ style })}
          />
        </Field>
        <Field label="Metric">
          <SegmentedControl
            label="Metric"
            options={METRIC_OPTIONS}
            value={widget.metric}
            onChange={(metric) => onChange({ metric })}
          />
        </Field>
      </>
    );
  }
  if (widget.kind === "query") {
    return (
      <>
        <Field label="Display">
          <SegmentedControl
            label="Display"
            options={RESULT_DISPLAYS.map((option) => ({
              label: option.label,
              value: option.id,
            }))}
            value={widget.display}
            onChange={(display) => onChange({ display })}
          />
        </Field>
        <Field label="Number format">
          <SegmentedControl
            label="Number format"
            options={VALUE_FORMATS.map((option) => ({
              label: option.label,
              value: option.id,
            }))}
            value={widget.format}
            onChange={(format) => onChange({ format })}
          />
        </Field>
      </>
    );
  }
  if (widget.kind === "breakdown") {
    return (
      <>
        <Field label="Chart type">
          <SegmentedControl
            label="Chart type"
            options={BREAKDOWN_STYLES.map((style) => ({
              label: style.label,
              value: style.id,
            }))}
            value={widget.style}
            onChange={(style) => onChange({ style })}
          />
        </Field>
        <Field label="Metric">
          <SegmentedControl
            label="Metric"
            options={METRIC_OPTIONS}
            value={widget.metric}
            onChange={(metric) => onChange({ metric })}
          />
        </Field>
      </>
    );
  }
  return null;
};

const WidgetSettings = ({
  onChange,
  widget,
}: {
  onChange: (changes: Partial<Widget>) => void;
  widget: Widget;
}) => {
  const titleId = useId();
  const editableTitle = widget.kind !== "stats" && widget.kind !== "slot";
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Configure ${widgetTitle(widget)}`}
        title="Configure"
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <Settings2 className="size-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="w-72 space-y-4 rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl transition data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <Popover.Title className="text-sm font-semibold">
              {widgetTitle(widget)}
            </Popover.Title>
            {editableTitle && (
              <div className="space-y-1.5">
                <label
                  htmlFor={titleId}
                  className="text-xs font-medium text-muted-foreground"
                >
                  Title
                </label>
                <input
                  id={titleId}
                  className="h-8 w-full rounded-lg border bg-card px-2.5 text-sm outline-none focus:border-primary focus:ring-3 focus:ring-primary/20"
                  maxLength={80}
                  placeholder={widgetTitle({ ...widget, title: undefined })}
                  value={widget.title ?? ""}
                  onChange={(event) =>
                    onChange({ title: event.target.value || undefined })
                  }
                />
              </div>
            )}
            <ChartOptions widget={widget} onChange={onChange} />
            <Field label="Width">
              <SegmentedControl
                label="Width"
                options={WIDGET_SIZES.map((size) => ({
                  label: size.label,
                  value: size.id,
                }))}
                value={widget.size}
                onChange={(size) => onChange({ size })}
              />
            </Field>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const ChartBuilder = ({
  capabilities,
  onAdd,
  onOpenChange,
  open,
}: {
  capabilities: ViewCapabilities;
  onAdd: (widget: WidgetDraft) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const [type, setType] = useState<"timeline" | "breakdown">(
    capabilities.timeline ? "timeline" : "breakdown"
  );
  const [dimension, setDimension] = useState<Dimension>(
    capabilities.dimensions[0] ?? "agent"
  );
  const [metric, setMetric] = useState<ChartMetric>("cost");
  const [timelineStyle, setTimelineStyle] =
    useState<(typeof TIMELINE_STYLES)[number]["id"]>("area");
  const [breakdownStyle, setBreakdownStyle] =
    useState<(typeof BREAKDOWN_STYLES)[number]["id"]>("donut");
  const [size, setSize] = useState<WidgetSize>("md");
  const [title, setTitle] = useState("");
  const titleId = useId();
  const typeOptions = [
    ...(capabilities.timeline
      ? [{ label: "Over time", value: "timeline" as const }]
      : []),
    ...(capabilities.dimensions.length
      ? [{ label: "Breakdown", value: "breakdown" as const }]
      : []),
  ];
  const create = (): void => {
    const trimmed = title.trim() || undefined;
    onAdd(
      type === "timeline"
        ? {
            kind: "timeline",
            metric,
            size,
            style: timelineStyle,
            title: trimmed,
          }
        : {
            dimension,
            kind: "breakdown",
            metric,
            size,
            style: breakdownStyle,
            title: trimmed,
          }
    );
    setTitle("");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Build a chart</DialogTitle>
          <DialogDescription>
            Pick what to plot and how. You can change any of it later from the
            chart’s settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Chart">
            <SegmentedControl
              label="Chart"
              options={typeOptions}
              value={type}
              onChange={setType}
            />
          </Field>
          {type === "breakdown" && (
            <Field label="Group by">
              <SegmentedControl
                label="Group by"
                options={DIMENSIONS.filter((item) =>
                  capabilities.dimensions.includes(item.id)
                ).map((item) => ({ label: item.label, value: item.id }))}
                value={dimension}
                onChange={setDimension}
              />
            </Field>
          )}
          <Field label="Metric">
            <SegmentedControl
              label="Metric"
              options={METRIC_OPTIONS}
              value={metric}
              onChange={setMetric}
            />
          </Field>
          <Field label="Style">
            {type === "timeline" ? (
              <SegmentedControl
                label="Style"
                options={TIMELINE_STYLES.map((style) => ({
                  label: style.label,
                  value: style.id,
                }))}
                value={timelineStyle}
                onChange={setTimelineStyle}
              />
            ) : (
              <SegmentedControl
                label="Style"
                options={BREAKDOWN_STYLES.map((style) => ({
                  label: style.label,
                  value: style.id,
                }))}
                value={breakdownStyle}
                onChange={setBreakdownStyle}
              />
            )}
          </Field>
          <Field label="Width">
            <SegmentedControl
              label="Width"
              options={WIDGET_SIZES.map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              value={size}
              onChange={setSize}
            />
          </Field>
          <div className="space-y-1.5">
            <label
              htmlFor={titleId}
              className="text-xs font-medium text-muted-foreground"
            >
              Title (optional)
            </label>
            <input
              id={titleId}
              className="h-9 w-full rounded-lg border bg-card px-3 text-sm outline-none focus:border-primary focus:ring-3 focus:ring-primary/20"
              maxLength={80}
              placeholder="e.g. Weekly spend"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={create}
            className="brand-gradient inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-primary-foreground"
          >
            <Plus className="size-4" />
            Add chart
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const AddWidgetMenu = ({
  capabilities,
  onAdd,
  onBuild,
  onWriteQuery,
  present,
}: {
  capabilities: ViewCapabilities;
  onAdd: (widget: Widget) => void;
  onBuild: () => void;
  onWriteQuery: () => void;
  present: Set<string>;
}) => {
  const available = widgetTemplates(capabilities).filter(
    (template) => !present.has(template.widget.id)
  );
  const canBuild = capabilities.timeline || capabilities.dimensions.length > 0;
  return (
    <Popover.Root>
      <Popover.Trigger className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium transition hover:bg-muted">
        <Plus className="size-3.5" />
        Add widget
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="w-64 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl transition data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            {capabilities.queries && (
              <Popover.Close
                onClick={onWriteQuery}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-primary transition hover:bg-muted"
              >
                <Code2 className="size-4" />
                Write a query (SQL, TS, JS)…
              </Popover.Close>
            )}
            {canBuild && (
              <Popover.Close
                onClick={onBuild}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-primary transition hover:bg-muted"
              >
                <Sparkles className="size-4" />
                Build a custom chart…
              </Popover.Close>
            )}
            {available.length > 0 && (
              <p className="px-2.5 pt-2 pb-1 text-3xs font-semibold uppercase tracking-caps text-muted-foreground">
                Restore
              </p>
            )}
            {available.map((template) => (
              <Popover.Close
                key={template.widget.id}
                onClick={() => onAdd(template.widget)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-muted"
              >
                <Plus className="size-3.5 text-muted-foreground" />
                {template.label}
              </Popover.Close>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const EditableWidget = ({
  children,
  dragging,
  isFirst,
  isLast,
  onDragEnd,
  onDragStart,
  onDropOn,
  onMove,
  onRemove,
  onChange,
  widget,
}: {
  children: React.ReactNode;
  dragging: boolean;
  isFirst: boolean;
  isLast: boolean;
  onChange: (changes: Partial<Widget>) => void;
  onDragEnd: () => void;
  onDragStart: () => void;
  onDropOn: (draggedId: string) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  widget: Widget;
}) => {
  const [over, setOver] = useState(false);
  const title = widgetTitle(widget);
  return (
    // Drag and drop needs handlers on the tile itself; the move buttons in its
    // toolbar give keyboard users the same control.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      aria-label={title}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", widget.id);
        onDragStart();
      }}
      onDragEnd={() => {
        setOver(false);
        onDragEnd();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDropOn(event.dataTransfer.getData("text/plain"));
      }}
      className={cn(
        "relative rounded-2xl outline-2 outline-offset-4 outline-dashed transition",
        SIZE_CLASSES[widget.size],
        over ? "outline-primary" : "outline-primary/30",
        dragging && "opacity-40"
      )}
    >
      <div className="absolute -top-4 right-3 z-10 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-lg">
        <span
          title="Drag to reorder"
          className="grid size-7 cursor-grab place-items-center text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className="max-w-40 truncate px-1 text-2xs font-medium">
          {title}
        </span>
        <button
          type="button"
          aria-label={`Move ${title} earlier`}
          title="Move earlier"
          disabled={isFirst}
          onClick={() => onMove(-1)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Move ${title} later`}
          title="Move later"
          disabled={isLast}
          onClick={() => onMove(1)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ArrowDown className="size-3.5" />
        </button>
        <WidgetSettings widget={widget} onChange={onChange} />
        <button
          type="button"
          aria-label={`Remove ${title}`}
          title="Remove"
          onClick={onRemove}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {children}
    </section>
  );
};

/**
 * Renders a view as an ordered grid of widgets that people can reorder,
 * resize, reconfigure, remove and extend with their own charts. Layouts are
 * saved per view in this browser.
 */
export const CustomizableView = ({
  actions,
  data,
  heading,
  view,
}: {
  actions?: React.ReactNode;
  data: ViewData;
  heading: React.ReactNode;
  view: ViewId;
}) => {
  const [widgets, changeWidgets] = useViewLayout(view);
  const [editing, setEditing] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [queryEditorOpen, setQueryEditorOpen] = useState(false);
  const { query } = data;
  // Stable per underlying arrays, so query results stay cached across
  // renders that rebuild the view's data object.
  const queryTables = useMemo(
    () => (query ? buildTables({ ...query }) : EMPTY_TABLES),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the arrays themselves
    [
      query?.agents,
      query?.daily,
      query?.hourly,
      query?.models,
      query?.projects,
      query?.sessions,
    ]
  );
  const [draggedId, setDraggedId] = useState<string>();
  const capabilities = capabilitiesOf(data);
  const visible = widgets.filter((widget) =>
    isWidgetSupported(widget, capabilities)
  );
  const present = new Set(widgets.map((widget) => widget.id));

  useEffect(() => {
    if (!editing) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !builderOpen) {
        setEditing(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [builderOpen, editing]);

  // SAFETY: settings only send fields that belong to the edited widget's kind.
  const update = (id: string, changes: Partial<Widget>): void =>
    changeWidgets((current) =>
      current.map((widget) =>
        widget.id === id ? ({ ...widget, ...changes } as Widget) : widget
      )
    );
  // SAFETY: a draft is a complete widget apart from its id, added here.
  const add = (widget: WidgetDraft, base = "custom-chart"): void =>
    changeWidgets((current) => [
      ...current,
      { ...widget, id: uniqueWidgetId(current, base) } as Widget,
    ]);

  const controls = editing ? (
    <div className="flex flex-wrap items-center gap-2">
      <AddWidgetMenu
        capabilities={capabilities}
        present={present}
        onAdd={(widget) => add(widget, widget.id)}
        onBuild={() => setBuilderOpen(true)}
        onWriteQuery={() => setQueryEditorOpen(true)}
      />
      <button
        type="button"
        onClick={() => changeWidgets(() => DEFAULT_LAYOUTS[view])}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium transition hover:bg-muted"
      >
        <RotateCcw className="size-3.5" />
        Reset
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="brand-gradient inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-primary-foreground"
      >
        <Check className="size-3.5" />
        Done
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium text-muted-foreground transition hover:text-foreground"
    >
      <LayoutGrid className="size-3.5" />
      Customise
    </button>
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">{heading}</div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {controls}
        </div>
      </div>
      {editing && (
        <p className="animate-rise mb-6 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-4 py-2.5 text-sm text-muted-foreground">
          Drag widgets to reorder them, or use the arrows. Use{" "}
          <Settings2 className="inline size-3.5" /> to change a chart’s type,
          metric, title and width. Changes save automatically.
        </p>
      )}
      <div className={cn("grid grid-cols-12 gap-4", editing && "gap-y-8")}>
        {visible.map((widget, index) => {
          const content = (
            <WidgetContent
              data={data}
              queryTables={queryTables}
              widget={widget}
              onChange={(changes) => update(widget.id, changes)}
            />
          );
          if (!editing) {
            return (
              <div key={widget.id} className={SIZE_CLASSES[widget.size]}>
                {content}
              </div>
            );
          }
          return (
            <EditableWidget
              key={widget.id}
              widget={widget}
              dragging={draggedId === widget.id}
              isFirst={index === 0}
              isLast={index === visible.length - 1}
              onChange={(changes) => update(widget.id, changes)}
              onDragStart={() => setDraggedId(widget.id)}
              onDragEnd={() => setDraggedId(undefined)}
              onDropOn={(droppedId) => {
                const sourceId = droppedId || draggedId;
                if (sourceId) {
                  changeWidgets((current) =>
                    moveWidget(current, sourceId, widget.id)
                  );
                }
                setDraggedId(undefined);
              }}
              onMove={(direction) => {
                const target = visible[index + direction];
                if (target) {
                  changeWidgets((current) =>
                    moveWidget(current, widget.id, target.id)
                  );
                }
              }}
              onRemove={() =>
                changeWidgets((current) =>
                  current.filter((item) => item.id !== widget.id)
                )
              }
            >
              {content}
            </EditableWidget>
          );
        })}
        {!visible.length && (
          <div className="col-span-12 grid place-items-center gap-3 rounded-xl border border-dashed py-16 text-sm text-muted-foreground">
            This view is empty.
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setBuilderOpen(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium text-foreground"
            >
              <Plus className="size-3.5" />
              Add a chart
            </button>
          </div>
        )}
      </div>
      <ChartBuilder
        capabilities={capabilities}
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        onAdd={(widget) => add(widget)}
      />
      {capabilities.queries && queryEditorOpen && (
        <Suspense fallback={null}>
          <QueryEditorDialog
            mode="create"
            open={queryEditorOpen}
            onOpenChange={setQueryEditorOpen}
            tables={queryTables}
            initial={NEW_QUERY}
            onSave={(draft) =>
              add({ ...draft, kind: "query", size: "md" }, "query")
            }
          />
        </Suspense>
      )}
    </>
  );
};
