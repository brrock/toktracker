import type { DashboardSummary, TimeRange } from "@toktracker/shared";
import { BarChart3 } from "lucide-react";
import { useState } from "react";

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
import { cn } from "@/lib/utils";

import {
  BreakdownIcon,
  Card,
  CardHeader,
  EmptyState,
  METRIC_OPTIONS,
  SegmentedControl,
} from "./primitives";

type ChartMetric = "tokens" | "cost";

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

export const DailySpendChart = ({
  daily,
  hourly = EMPTY_HOURLY,
  periodLabel,
  range,
  title = "Spend over time",
}: {
  daily: DashboardSummary["daily"];
  hourly?: DashboardSummary["hourly"];
  periodLabel: string;
  range?: TimeRange;
  title?: string;
}) => {
  const [metric, setMetric] = useState<ChartMetric>("cost");
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
  const formatValue = (value: number): string =>
    metric === "cost" ? money(value) : compact(value);
  const pointLabel = (date: string): string =>
    isHourly ? chartHourLabel(date) : chartPeriodLabel(date, granularity);
  const active = hovered === undefined ? undefined : chartData[hovered];

  return (
    <Card>
      <CardHeader
        title={title}
        description={`${isHourly ? "Hourly" : granularityLabel(granularity)} ${metric === "cost" ? "tracked spend" : "token usage"} · ${dateRange}`}
        action={
          <SegmentedControl
            label="Chart metric"
            options={METRIC_OPTIONS}
            value={metric}
            onChange={setMetric}
          />
        }
      />
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-heading text-3xl font-semibold tabular-nums tracking-tight">
          {formatValue(active ? active[metric] : total)}
        </span>
        <span className="text-sm text-muted-foreground">
          {active ? pointLabel(active.date) : "total in view"}
        </span>
      </div>
      {chartData.length ? (
        <div className="relative mt-5 h-60 pl-12">
          <div className="pointer-events-none absolute top-0 left-0 right-0 bottom-6 flex flex-col justify-between">
            {Array.from({ length: GRID_LINES + 1 }, (_, line) => (
              <div
                key={line}
                className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground"
              >
                <span className="w-10 shrink-0 text-right">
                  {formatValue(
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
          <div
            className="relative flex h-full items-end gap-[3px]"
            onMouseLeave={() => setHovered(undefined)}
          >
            {chartData.map((point, index) => {
              const showLabel =
                index % labelInterval === 0 || index === chartData.length - 1;
              const isActive = hovered === index;
              const isDimmed = hovered !== undefined && !isActive;
              return (
                <button
                  key={point.date}
                  type="button"
                  aria-label={`${pointLabel(point.date)}: ${formatValue(point[metric])}`}
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(undefined)}
                  className="group flex h-full min-w-0 flex-1 cursor-default flex-col justify-end focus:outline-none"
                >
                  <span className="relative flex min-h-0 w-full flex-1 items-end pb-0">
                    <span
                      className={cn(
                        "animate-grow-up w-full rounded-t-[calc(var(--radius)*0.5)] transition-opacity duration-200",
                        isDimmed && "opacity-35"
                      )}
                      style={{
                        animationDelay: `${index * 12}ms`,
                        background:
                          "linear-gradient(to top, color-mix(in oklch, var(--chart-1) 55%, transparent), var(--chart-1))",
                        height: `${Math.max(2, (point[metric] / maximumValue) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="mt-2 h-4 w-full overflow-visible whitespace-nowrap text-center text-[10px] text-muted-foreground">
                    {showLabel ? pointLabel(point.date) : ""}
                  </span>
                </button>
              );
            })}
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

export const UsageBreakdownChart = ({
  entries,
  kind,
  periodLabel,
  title,
}: {
  entries: { name: string; tokens: number; cost: number }[];
  kind: "agent" | "model" | "project";
  periodLabel: string;
  title: string;
}) => {
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const sorted = entries.toSorted(
    (left, right) => right[metric] - left[metric]
  );
  const ranked = sorted.slice(0, 5);
  const otherValue = sorted
    .slice(5)
    .reduce((sum, entry) => sum + entry[metric], 0);
  const total = sorted.reduce((sum, entry) => sum + entry[metric], 0) || 1;
  const maximum = ranked[0]?.[metric] || 1;
  const format = (value: number): string =>
    metric === "tokens" ? compact(value) : money(value);
  return (
    <Card>
      <CardHeader
        title={title}
        description={`${metric === "tokens" ? "Token usage" : "Tracked spend"} · ${periodLabel}`}
        action={
          <SegmentedControl
            label={`${title} metric`}
            options={METRIC_OPTIONS}
            value={metric}
            onChange={setMetric}
          />
        }
      />
      {ranked.length > 0 && (
        <div className="mt-5 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
          {ranked.map((entry, index) => (
            <span
              key={entry.name}
              title={`${entry.name}: ${format(entry[metric])}`}
              className="animate-grow-right h-full first:rounded-l-full"
              style={{
                animationDelay: `${index * 60}ms`,
                background: seriesColor(index),
                width: `${(entry[metric] / total) * 100}%`,
              }}
            />
          ))}
          {otherValue > 0 && (
            <span
              className="h-full rounded-r-full"
              style={{
                background: seriesColor(SERIES_COLORS.length - 1),
                width: `${(otherValue / total) * 100}%`,
              }}
            />
          )}
        </div>
      )}
      <div className="mt-5 space-y-3.5">
        {ranked.map((entry, index) => (
          <div key={entry.name}>
            <div className="mb-1.5 flex items-center gap-2 text-sm">
              <BreakdownIcon kind={kind} name={entry.name} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-medium",
                  kind === "agent" && "capitalize"
                )}
              >
                {entry.name}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.round((entry[metric] / total) * 100)}%
              </span>
              <span className="w-16 text-right text-xs font-medium tabular-nums">
                {format(entry[metric])}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted">
              <div
                className="animate-grow-right h-full rounded-full"
                style={{
                  animationDelay: `${index * 60}ms`,
                  background: seriesColor(index),
                  width: `${Math.max(3, (entry[metric] / maximum) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
        {!ranked.length && (
          <EmptyState icon={<BarChart3 />}>
            No usage data for this selection.
          </EmptyState>
        )}
      </div>
    </Card>
  );
};
