import type { DashboardSummary, TimeRange } from "@toktracker/shared";
import { BarChart3 } from "lucide-react";
import { useId, useState } from "react";

import {
  aggregateChartData,
  allTimeChartGranularity,
  chartDate,
  chartHourLabel,
  chartPeriodLabel,
  compact,
  EMPTY_HOURLY,
  money,
} from "@/lib/dashboard";
import type { BreakdownStyle, Dimension, TimelineStyle } from "@/lib/layout";
import { cn } from "@/lib/utils";

import {
  BreakdownIcon,
  Card,
  CardHeader,
  EmptyState,
  METRIC_OPTIONS,
  SegmentedControl,
} from "./primitives";

export type ChartMetric = "tokens" | "cost";

export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
] as const;

const seriesColor = (index: number): string =>
  SERIES_COLORS[index % SERIES_COLORS.length] ?? "var(--chart-1)";

const GRID_LINES = 4;
const RANKED_ENTRIES = 5;
const CHART_WIDTH = 100;
const CHART_HEIGHT = 100;
// A circumference of 100 lets arc lengths be written as percentages.
const DONUT_RADIUS = 15.9155;

const GRANULARITY_LABELS = {
  day: "Daily",
  half: "Half-yearly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
} as const;
const granularityLabel = (
  granularity: keyof typeof GRANULARITY_LABELS
): string => GRANULARITY_LABELS[granularity];

const formatMetric = (metric: ChartMetric, value: number): string =>
  metric === "cost" ? money(value) : compact(value);

/** Keeps a chart's metric in the layout when it is customisable. */
const useMetric = (
  initial: ChartMetric,
  metric: ChartMetric | undefined,
  onMetricChange: ((metric: ChartMetric) => void) | undefined
): [ChartMetric, (metric: ChartMetric) => void] => {
  const [local, setLocal] = useState<ChartMetric>(initial);
  return [metric ?? local, onMetricChange ?? setLocal];
};

const TimelineSvg = ({
  metric,
  points,
  hovered,
  maximum,
  variant,
}: {
  hovered: number | undefined;
  maximum: number;
  metric: ChartMetric;
  points: DashboardSummary["daily"];
  variant: "area" | "line";
}) => {
  const gradientId = useId();
  const step = points.length > 1 ? CHART_WIDTH / (points.length - 1) : 0;
  const coordinates = points.map((point, index) => ({
    x: points.length > 1 ? index * step : CHART_WIDTH / 2,
    y: CHART_HEIGHT - (point[metric] / maximum) * (CHART_HEIGHT - 4),
  }));
  const line = coordinates
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");
  const active = hovered === undefined ? undefined : coordinates[hovered];
  return (
    <>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="animate-rise pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {variant === "area" && (
          <path
            d={`${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`}
            fill={`url(#${gradientId})`}
          />
        )}
        <path
          d={line}
          fill="none"
          stroke="var(--chart-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.25"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {active && (
        <span
          className="pointer-events-none absolute top-(--point-y) left-(--point-x) size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary shadow"
          style={{
            "--point-x": `${(active.x / CHART_WIDTH) * 100}%`,
            "--point-y": `${(active.y / CHART_HEIGHT) * 100}%`,
          }}
        />
      )}
    </>
  );
};

export const DailySpendChart = ({
  action,
  daily,
  hourly = EMPTY_HOURLY,
  metric: controlledMetric,
  onMetricChange,
  periodLabel,
  range,
  title = "Spend over time",
  variant = "bar",
}: {
  action?: React.ReactNode;
  daily: DashboardSummary["daily"];
  hourly?: DashboardSummary["hourly"];
  metric?: ChartMetric;
  onMetricChange?: (metric: ChartMetric) => void;
  periodLabel: string;
  range?: TimeRange;
  title?: string;
  variant?: TimelineStyle;
}) => {
  const [metric, setMetric] = useMetric(
    "cost",
    controlledMetric,
    onMetricChange
  );
  const [hovered, setHovered] = useState<number>();
  const isHourly = range === "day";
  const isAllTime = range === "all";
  const granularity = isAllTime ? allTimeChartGranularity(daily) : "day";
  let chartData = daily.slice(-30);
  if (isHourly) {
    chartData = hourly.slice(-24);
  } else if (isAllTime) {
    chartData = aggregateChartData(daily, granularity);
  }
  const maximumValue = Math.max(...chartData.map((point) => point[metric]), 1);
  const total = chartData.reduce((sum, point) => sum + point[metric], 0);
  const labelInterval = Math.max(1, Math.ceil(chartData.length / 6));
  const firstDate = chartData[0]?.date;
  const lastDate = chartData.at(-1)?.date;
  let dateRange = periodLabel;
  if (firstDate && lastDate) {
    dateRange = isHourly
      ? `${chartHourLabel(firstDate)} – ${chartHourLabel(lastDate)}`
      : `${chartDate(firstDate)} – ${chartDate(lastDate)}`;
  }
  const pointLabel = (date: string): string =>
    isHourly ? chartHourLabel(date) : chartPeriodLabel(date, granularity);
  const active = hovered === undefined ? undefined : chartData[hovered];

  return (
    <Card className="h-full">
      <CardHeader
        title={title}
        description={`${isHourly ? "Hourly" : granularityLabel(granularity)} ${metric === "cost" ? "tracked spend" : "token usage"} · ${dateRange}`}
        action={
          <div className="flex items-center gap-2">
            <SegmentedControl
              label="Chart metric"
              options={METRIC_OPTIONS}
              value={metric}
              onChange={setMetric}
            />
            {action}
          </div>
        }
      />
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-heading text-3xl font-semibold tabular-nums tracking-tight">
          {formatMetric(metric, active ? active[metric] : total)}
        </span>
        <span className="text-sm text-muted-foreground">
          {active ? pointLabel(active.date) : "total in view"}
        </span>
      </div>
      {chartData.length ? (
        <div className="relative mt-5 h-60 pl-12">
          <div className="pointer-events-none absolute top-0 right-0 bottom-6 left-0 flex flex-col justify-between">
            {Array.from({ length: GRID_LINES + 1 }, (_, line) => (
              <div
                key={line}
                className="flex items-center gap-2 text-3xs tabular-nums text-muted-foreground"
              >
                <span className="w-10 shrink-0 text-right">
                  {formatMetric(
                    metric,
                    (maximumValue * (GRID_LINES - line)) / GRID_LINES
                  )}
                </span>
                <span
                  className={cn(
                    "h-px flex-1",
                    line === GRID_LINES ? "bg-border" : "border-t border-dashed"
                  )}
                />
              </div>
            ))}
          </div>
          <div className="relative h-full">
            {variant !== "bar" && (
              <div className="absolute inset-x-0 top-0 bottom-6">
                <TimelineSvg
                  hovered={hovered}
                  maximum={maximumValue}
                  metric={metric}
                  points={chartData}
                  variant={variant}
                />
              </div>
            )}
            <div
              className={cn(
                "relative flex h-full items-end",
                variant === "bar" ? "gap-0.75" : "gap-0"
              )}
              onMouseLeave={() => setHovered(undefined)}
            >
              {chartData.map((point, index) => {
                const showLabel =
                  index % labelInterval === 0 || index === chartData.length - 1;
                const isDimmed = hovered !== undefined && hovered !== index;
                return (
                  <button
                    key={point.date}
                    type="button"
                    aria-label={`${pointLabel(point.date)}: ${formatMetric(metric, point[metric])}`}
                    onMouseEnter={() => setHovered(index)}
                    onFocus={() => setHovered(index)}
                    onBlur={() => setHovered(undefined)}
                    className="group flex h-full min-w-0 flex-1 cursor-default flex-col justify-end focus:outline-none"
                  >
                    <span className="relative flex min-h-0 w-full flex-1 items-end">
                      {variant === "bar" ? (
                        <span
                          className={cn(
                            "animate-grow-up stagger bar-fill h-(--bar-size) w-full rounded-t-sm transition-opacity duration-200",
                            isDimmed && "opacity-35"
                          )}
                          style={{
                            "--bar-size": `${Math.max(2, (point[metric] / maximumValue) * 100)}%`,
                            "--stagger-index": index,
                          }}
                        />
                      ) : (
                        <span
                          className={cn(
                            "mx-auto h-full w-px transition-colors",
                            hovered === index && "bg-primary/30"
                          )}
                        />
                      )}
                    </span>
                    <span className="mt-2 h-4 w-full overflow-visible whitespace-nowrap text-center text-3xs text-muted-foreground">
                      {showLabel ? pointLabel(point.date) : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <EmptyState icon={<BarChart3 />}>
            No usage data for this selection yet.
          </EmptyState>
        </div>
      )}
    </Card>
  );
};

interface BreakdownEntry {
  cost: number;
  name: string;
  tokens: number;
}

const BreakdownLabel = ({
  entry,
  kind,
}: {
  entry: BreakdownEntry;
  kind: Dimension;
}) => (
  <>
    <BreakdownIcon kind={kind} name={entry.name} />
    <span
      className={cn(
        "min-w-0 flex-1 truncate font-medium",
        kind === "agent" && "capitalize"
      )}
    >
      {entry.name}
    </span>
  </>
);

const BreakdownBars = ({
  entries,
  kind,
  maximum,
  metric,
  total,
}: {
  entries: BreakdownEntry[];
  kind: Dimension;
  maximum: number;
  metric: ChartMetric;
  total: number;
}) => (
  <div className="mt-5 space-y-3.5">
    {entries.map((entry, index) => (
      <div key={entry.name}>
        <div className="mb-1.5 flex items-center gap-2 text-sm">
          <BreakdownLabel entry={entry} kind={kind} />
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.round((entry[metric] / total) * 100)}%
          </span>
          <span className="w-16 text-right text-xs font-medium tabular-nums">
            {formatMetric(metric, entry[metric])}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted">
          <div
            className="animate-grow-right stagger h-full w-(--bar-size) rounded-full bg-(--series)"
            style={{
              "--bar-size": `${Math.max(3, (entry[metric] / maximum) * 100)}%`,
              "--series": seriesColor(index),
              "--stagger-index": index,
              "--stagger-step": "60ms",
            }}
          />
        </div>
      </div>
    ))}
  </div>
);

const BreakdownDonut = ({
  entries,
  kind,
  metric,
  otherValue,
  total,
}: {
  entries: BreakdownEntry[];
  kind: Dimension;
  metric: ChartMetric;
  otherValue: number;
  total: number;
}) => {
  const slices = [
    ...entries.map((entry, index) => ({
      color: seriesColor(index),
      name: entry.name,
      value: entry[metric],
    })),
    ...(otherValue > 0
      ? [
          {
            color: seriesColor(SERIES_COLORS.length - 1),
            name: "Other",
            value: otherValue,
          },
        ]
      : []),
  ];
  let offset = 0;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-6">
      <div className="relative size-40 shrink-0">
        <svg
          aria-hidden="true"
          viewBox="0 0 42 42"
          className="animate-rise size-full -rotate-90"
        >
          <circle
            cx="21"
            cy="21"
            r={DONUT_RADIUS}
            fill="none"
            stroke="var(--muted)"
            strokeWidth="6"
          />
          {slices.map((slice) => {
            const share = (slice.value / total) * 100;
            const dash = `${Math.max(0, share - 0.6)} ${100 - Math.max(0, share - 0.6)}`;
            const circle = (
              <circle
                key={slice.name}
                cx="21"
                cy="21"
                r={DONUT_RADIUS}
                fill="none"
                stroke={slice.color}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                strokeWidth="6"
              />
            );
            offset += share;
            return circle;
          })}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="font-heading text-lg font-semibold tabular-nums">
              {formatMetric(metric, total)}
            </div>
            <div className="text-3xs uppercase tracking-wider text-muted-foreground">
              total
            </div>
          </div>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-2 text-sm">
        {entries.map((entry, index) => (
          <li key={entry.name} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full bg-(--series)"
              style={{ "--series": seriesColor(index) }}
            />
            <BreakdownLabel entry={entry} kind={kind} />
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round((entry[metric] / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const BreakdownColumns = ({
  entries,
  kind,
  maximum,
  metric,
}: {
  entries: BreakdownEntry[];
  kind: Dimension;
  maximum: number;
  metric: ChartMetric;
}) => (
  <div className="mt-5 flex h-56 items-end gap-3">
    {entries.map((entry, index) => (
      <div
        key={entry.name}
        className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2"
      >
        <span className="text-xs font-medium tabular-nums">
          {formatMetric(metric, entry[metric])}
        </span>
        <div
          className="animate-grow-up stagger h-(--bar-size) w-full max-w-16 rounded-t-sm bg-(--series)"
          style={{
            "--bar-size": `${Math.max(3, (entry[metric] / maximum) * 75)}%`,
            "--series": seriesColor(index),
            "--stagger-index": index,
            "--stagger-step": "60ms",
          }}
        />
        <span
          className={cn(
            "flex w-full min-w-0 items-center justify-center gap-1 text-2xs text-muted-foreground",
            kind === "agent" && "capitalize"
          )}
          title={entry.name}
        >
          <span className="truncate">{entry.name}</span>
        </span>
      </div>
    ))}
  </div>
);

export const UsageBreakdownChart = ({
  action,
  entries,
  kind,
  metric: controlledMetric,
  onMetricChange,
  periodLabel,
  title,
  variant = "bars",
}: {
  action?: React.ReactNode;
  entries: BreakdownEntry[];
  kind: Dimension;
  metric?: ChartMetric;
  onMetricChange?: (metric: ChartMetric) => void;
  periodLabel: string;
  title: string;
  variant?: BreakdownStyle;
}) => {
  const [metric, setMetric] = useMetric(
    "tokens",
    controlledMetric,
    onMetricChange
  );
  const sorted = entries.toSorted(
    (left, right) => right[metric] - left[metric]
  );
  const ranked = sorted.slice(0, RANKED_ENTRIES);
  const otherValue = sorted
    .slice(RANKED_ENTRIES)
    .reduce((sum, entry) => sum + entry[metric], 0);
  const total = sorted.reduce((sum, entry) => sum + entry[metric], 0) || 1;
  const maximum = ranked[0]?.[metric] || 1;
  return (
    <Card className="h-full">
      <CardHeader
        title={title}
        description={`${metric === "tokens" ? "Token usage" : "Tracked spend"} · ${periodLabel}`}
        action={
          <div className="flex items-center gap-2">
            <SegmentedControl
              label={`${title} metric`}
              options={METRIC_OPTIONS}
              value={metric}
              onChange={setMetric}
            />
            {action}
          </div>
        }
      />
      {ranked.length > 0 && variant === "bars" && (
        <div className="mt-5 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
          {ranked.map((entry, index) => (
            <span
              key={entry.name}
              title={`${entry.name}: ${formatMetric(metric, entry[metric])}`}
              className="animate-grow-right stagger h-full w-(--bar-size) bg-(--series) first:rounded-l-full"
              style={{
                "--bar-size": `${(entry[metric] / total) * 100}%`,
                "--series": seriesColor(index),
                "--stagger-index": index,
                "--stagger-step": "60ms",
              }}
            />
          ))}
          {otherValue > 0 && (
            <span
              className="h-full w-(--bar-size) rounded-r-full bg-(--series)"
              style={{
                "--bar-size": `${(otherValue / total) * 100}%`,
                "--series": seriesColor(SERIES_COLORS.length - 1),
              }}
            />
          )}
        </div>
      )}
      {ranked.length > 0 && variant === "bars" && (
        <BreakdownBars
          entries={ranked}
          kind={kind}
          maximum={maximum}
          metric={metric}
          total={total}
        />
      )}
      {ranked.length > 0 && variant === "donut" && (
        <BreakdownDonut
          entries={ranked}
          kind={kind}
          metric={metric}
          otherValue={otherValue}
          total={total}
        />
      )}
      {ranked.length > 0 && variant === "columns" && (
        <BreakdownColumns
          entries={ranked}
          kind={kind}
          maximum={maximum}
          metric={metric}
        />
      )}
      {!ranked.length && (
        <div className="mt-5">
          <EmptyState icon={<BarChart3 />}>
            No usage data for this selection.
          </EmptyState>
        </div>
      )}
    </Card>
  );
};
