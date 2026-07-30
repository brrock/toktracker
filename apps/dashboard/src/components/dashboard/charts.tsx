import type { DashboardSummary, TimeRange } from "@toktracker/shared";
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

import { BreakdownIcon, Card, EmptyState } from "./primitives";

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
  const [metric, setMetric] = useState<"tokens" | "cost">("cost");
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
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {isHourly
              ? "Hourly"
              : `${granularity === "day" ? "Daily" : `${granularity[0]?.toUpperCase()}${granularity.slice(1)}`} `}
            {metric === "cost" ? "tracked spend" : "token usage"} · {dateRange}
          </p>
        </div>
        <select
          aria-label="Chart metric"
          value={metric}
          onChange={(event) =>
            setMetric(event.target.value as "tokens" | "cost")
          }
          className="h-8 rounded-md border bg-background px-2 text-xs font-medium"
        >
          <option value="cost">Cost</option>
          <option value="tokens">Tokens</option>
        </select>
      </div>
      {chartData.length ? (
        <div className="mt-7 flex h-60 items-end gap-1.5">
          {chartData.map((point, index) => {
            const showLabel =
              index % labelInterval === 0 || index === chartData.length - 1;
            const label = isHourly
              ? chartHourLabel(point.date)
              : chartPeriodLabel(point.date, granularity);
            return (
              <div
                key={point.date}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                <div className="group relative flex min-h-0 flex-1 items-end">
                  <div
                    title={`${point.date} ${formatValue(point[metric])}`}
                    className="w-full rounded-t bg-primary/20 transition hover:bg-primary"
                    style={{
                      height: `${Math.max(4, (point[metric] / maximumValue) * 100)}%`,
                    }}
                  />
                  <span className="absolute left-1/2 top-0 z-10 hidden -translate-x-1/2 rounded bg-popover px-1.5 py-1 text-[10px] shadow group-hover:block">
                    {formatValue(point[metric])}
                  </span>
                </div>
                <span className="mt-2 h-4 overflow-visible whitespace-nowrap text-center text-[9px] text-muted-foreground">
                  {showLabel ? label : ""}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-6">
          <EmptyState>No usage data for this selection.</EmptyState>
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
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const ranked = entries
    .toSorted((left, right) => right[metric] - left[metric])
    .slice(0, 6);
  const maximum = ranked[0]?.[metric] ?? 1;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {metric === "tokens" ? "Token usage" : "Tracked spend"} ·{" "}
            {periodLabel}
          </p>
        </div>
        <select
          value={metric}
          aria-label={`${title} metric`}
          onChange={(event) =>
            setMetric(event.target.value as "tokens" | "cost")
          }
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="tokens">Tokens</option>
          <option value="cost">Cost</option>
        </select>
      </div>
      <div className="mt-6 space-y-4">
        {ranked.map((entry) => (
          <div key={entry.name}>
            <div className="mb-2 flex items-center gap-2 text-sm">
              <BreakdownIcon kind={kind} name={entry.name} />
              <span
                className={`min-w-0 flex-1 truncate font-medium${kind === "model" ? "" : " capitalize"}`}
              >
                {entry.name}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {metric === "tokens"
                  ? compact(entry.tokens)
                  : money(entry.cost)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${Math.max(3, (entry[metric] / maximum) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
        {!ranked.length && (
          <EmptyState>No usage data for this selection.</EmptyState>
        )}
      </div>
    </Card>
  );
};
