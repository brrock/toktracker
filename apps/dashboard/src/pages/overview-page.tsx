import type { DashboardSummary, TimeRange } from "@toktracker/shared";
import { Activity, CircleDollarSign, Cpu, Zap } from "lucide-react";
import { useState } from "react";

import {
  DailySpendChart,
  UsageBreakdownChart,
} from "@/components/dashboard/charts";
import { Card, EmptyState, Stat } from "@/components/dashboard/primitives";
import { SessionTable } from "@/components/dashboard/session-table";
import { RANGE_OPTIONS, compact, money } from "@/lib/dashboard";
import { chartMetricSchema, timeRangeSchema } from "@/lib/schemas";

export const OverviewPage = ({
  data,
  range,
  setRange,
}: {
  data: DashboardSummary;
  range: TimeRange;
  setRange: (range: TimeRange) => void;
}) => {
  const [modelMetric, setModelMetric] = useState<"tokens" | "cost">("tokens");
  const periodLabel =
    RANGE_OPTIONS.find((option) => option.value === range)?.label ??
    "This month";
  const rankedModels = [...data.models].toSorted(
    (left, right) => right[modelMetric] - left[modelMetric]
  );
  const maximumModelValue = rankedModels[0]?.[modelMetric] ?? 1;

  return (
    <>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Good morning</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Here’s what your agents have been up to.
          </p>
        </div>
        <label className="sr-only" htmlFor="overview-range">
          Usage period
        </label>
        <select
          id="overview-range"
          value={range}
          onChange={(event) =>
            setRange(timeRangeSchema.parse(event.target.value))
          }
          className="h-9 rounded-md border bg-card px-3 text-xs font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/30"
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<CircleDollarSign />}
          label="Tracked spend"
          value={money(data.totals.cost)}
          note={`${money(data.totals.reportedCost)} reported · ${money(data.totals.estimatedCost)} estimated${data.totals.unpricedTokens ? ` · ${compact(data.totals.unpricedTokens)} unpriced tokens` : ""}`}
        />
        <Stat
          icon={<Zap />}
          label="Tokens used"
          value={compact(data.totals.tokens)}
          note={`${compact(data.totals.messages)} messages`}
        />
        <Stat
          icon={<Activity />}
          label="Sessions"
          value={compact(data.totals.sessions)}
          note="Tracked sessions"
        />
        <Stat
          icon={<Cpu />}
          label="Top model"
          value={data.models[0]?.name ?? "No data yet"}
          note={
            data.models[0]
              ? `${compact(data.models[0].tokens)} tokens`
              : "Start the client to sync"
          }
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <DailySpendChart
          daily={data.daily}
          hourly={data.hourly}
          periodLabel={periodLabel}
          range={range}
        />
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Usage by model</h3>
              <p className="text-sm text-muted-foreground">
                Rank models by tokens or cost
              </p>
            </div>
            <label className="sr-only" htmlFor="model-metric">
              Model ranking
            </label>
            <select
              id="model-metric"
              value={modelMetric}
              onChange={(event) =>
                setModelMetric(chartMetricSchema.parse(event.target.value))
              }
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="tokens">Tokens</option>
              <option value="cost">Cost</option>
            </select>
          </div>
          <div className="mt-6 space-y-5">
            {rankedModels.slice(0, 5).map((model) => (
              <div key={model.name}>
                <div className="mb-2 flex justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{model.name}</span>
                  <span className="text-muted-foreground">
                    {modelMetric === "tokens"
                      ? compact(model.tokens)
                      : money(model.cost)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.max(5, (model[modelMetric] / maximumModelValue) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            {!data.models.length && <EmptyState>No model data yet.</EmptyState>}
          </div>
        </Card>
      </section>
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <UsageBreakdownChart
          entries={data.agents}
          kind="agent"
          periodLabel={periodLabel}
          title="Usage by coding agent"
        />
        <UsageBreakdownChart
          entries={data.projects}
          kind="project"
          periodLabel={periodLabel}
          title="Usage by project"
        />
      </section>
      <section className="mt-5">
        <SessionTable
          sessions={data.recentSessions.slice(0, 6)}
          title="Recent sessions"
        />
      </section>
    </>
  );
};
