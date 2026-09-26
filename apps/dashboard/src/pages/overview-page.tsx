import type { DashboardSummary, TimeRange } from "@toktracker/shared";
import { Activity, CircleDollarSign, Cpu, Sparkles, Zap } from "lucide-react";

import {
  DailySpendChart,
  UsageBreakdownChart,
} from "@/components/dashboard/charts";
import { SegmentedControl, Stat } from "@/components/dashboard/primitives";
import { SessionTable } from "@/components/dashboard/session-table";
import { useAppearance } from "@/components/theme-provider";
import { greeting } from "@/lib/appearance";
import { RANGE_OPTIONS, compact, money } from "@/lib/dashboard";

const SPARKLINE_POINTS = 14;

const insight = (data: DashboardSummary, periodLabel: string): string => {
  const [topAgent] = data.agents.toSorted(
    (left, right) => right.tokens - left.tokens
  );
  if (!topAgent || data.totals.tokens === 0) {
    return "Here’s what your agents have been up to.";
  }
  const share = Math.round((topAgent.tokens / data.totals.tokens) * 100);
  const agentName = `${topAgent.name[0]?.toUpperCase()}${topAgent.name.slice(1)}`;
  return `${agentName} did ${share}% of the work ${periodLabel.toLowerCase()} across ${compact(data.totals.sessions)} sessions.`;
};

export const OverviewPage = ({
  data,
  range,
  setRange,
}: {
  data: DashboardSummary;
  range: TimeRange;
  setRange: (range: TimeRange) => void;
}) => {
  const { appearance } = useAppearance();
  const periodLabel =
    RANGE_OPTIONS.find((option) => option.value === range)?.label ??
    "This month";
  const trendSource = range === "day" ? data.hourly : data.daily;
  const recent = trendSource.slice(-SPARKLINE_POINTS);
  const averageCost = data.totals.sessions
    ? data.totals.cost / data.totals.sessions
    : 0;
  const today = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(new Date());

  return (
    <div className="animate-rise">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-primary">
            {today}
          </p>
          <h2 className="text-gradient mt-1.5 text-3xl font-semibold">
            {greeting(new Date(), appearance.displayName)}
          </h2>
          <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" />
            {insight(data, periodLabel)}
          </p>
        </div>
        <SegmentedControl
          label="Usage period"
          options={RANGE_OPTIONS}
          size="md"
          value={range}
          onChange={setRange}
        />
      </div>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<CircleDollarSign />}
          label="Tracked spend"
          value={money(data.totals.cost)}
          trend={recent.map((point) => point.cost)}
          note={`${money(data.totals.reportedCost)} reported · ${money(data.totals.estimatedCost)} estimated${data.totals.unpricedTokens ? ` · ${compact(data.totals.unpricedTokens)} unpriced tokens` : ""}`}
        />
        <Stat
          icon={<Zap />}
          label="Tokens used"
          value={compact(data.totals.tokens)}
          trend={recent.map((point) => point.tokens)}
          note={`${compact(data.totals.messages)} messages`}
        />
        <Stat
          icon={<Activity />}
          label="Sessions"
          value={compact(data.totals.sessions)}
          note={`${money(averageCost)} average per session`}
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
        <UsageBreakdownChart
          entries={data.models}
          kind="model"
          periodLabel={periodLabel}
          title="Usage by model"
        />
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
      <section className="mt-4">
        <SessionTable
          sessions={data.recentSessions.slice(0, 6)}
          title="Recent sessions"
        />
      </section>
    </div>
  );
};
