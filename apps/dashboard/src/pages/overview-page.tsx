import type { DashboardSummary, TimeRange } from "@toktracker/shared";
import { Activity, CircleDollarSign, Cpu, Sparkles, Zap } from "lucide-react";

import { CustomizableView } from "@/components/dashboard/customizable-view";
import { SegmentedControl, Stat } from "@/components/dashboard/primitives";
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

const localDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const dateLabel = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));

export const OverviewPage = ({
  data,
  date,
  range,
  setDate,
  setRange,
}: {
  data: DashboardSummary;
  date?: string;
  range: TimeRange;
  setDate: (date?: string) => void;
  setRange: (range: TimeRange) => void;
}) => {
  const { appearance } = useAppearance();
  const options = date
    ? RANGE_OPTIONS.map((option) =>
        option.value === "day" ? { ...option, label: dateLabel(date) } : option
      )
    : RANGE_OPTIONS;
  const periodLabel = date
    ? dateLabel(date)
    : (RANGE_OPTIONS.find((option) => option.value === range)?.label ??
      "This month");
  const todayKey = localDateKey(new Date());
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

  const stats = (
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
  );

  return (
    <div className="animate-rise">
      <CustomizableView
        view="overview"
        data={{
          breakdowns: {
            agent: data.agents,
            model: data.models,
            project: data.projects,
          },
          daily: data.daily,
          hourly: data.hourly,
          periodLabel,
          query: {
            agents: data.agents,
            daily: data.daily,
            hourly: range === "day" ? data.hourly : undefined,
            models: data.models,
            projects: data.projects,
            sessions: data.recentSessions,
          },
          range,
          sessions: data.recentSessions.slice(0, 6),
          stats,
        }}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Usage period"
              options={options}
              size="md"
              value={range}
              onChange={setRange}
            />
            <input
              type="date"
              aria-label="Show usage for a specific date"
              className="h-9 rounded-lg border bg-card px-3 text-sm"
              max={todayKey}
              value={date ?? ""}
              onChange={(event) => {
                const next = event.target.value;
                setDate(next && next !== todayKey ? next : undefined);
              }}
            />
          </div>
        }
        heading={
          <>
            <p className="text-xs font-medium uppercase tracking-caps text-primary">
              {today}
            </p>
            <h2 className="gradient-heading mt-1.5 text-3xl font-semibold">
              {greeting(new Date(), appearance.displayName)}
            </h2>
            <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Sparkles className="size-3.5 text-primary" />
              {insight(data, periodLabel)}
            </p>
          </>
        }
      />
    </div>
  );
};
