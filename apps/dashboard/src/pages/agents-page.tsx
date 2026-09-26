import type { DashboardSummary } from "@toktracker/shared";
import { ArrowUpRight, CircleDollarSign, Zap } from "lucide-react";
import { useParams } from "react-router-dom";

import {
  DailySpendChart,
  UsageBreakdownChart,
} from "@/components/dashboard/charts";
import { PageHeading } from "@/components/dashboard/page-heading";
import { AgentLogo, EmptyState, Stat } from "@/components/dashboard/primitives";
import { compact, matchesQuery, money } from "@/lib/dashboard";
import { Link } from "@/lib/navigation";

export const AgentsPage = ({
  data,
  query,
}: {
  data: DashboardSummary;
  query: string;
}) => {
  const agents = data.agents.filter((agent) =>
    matchesQuery([agent.name], query)
  );
  const totalTokens = data.agents.reduce((sum, agent) => sum + agent.tokens, 0);
  return (
    <PageHeading
      title="Agents"
      description="Token and spend attribution across coding agents."
    >
      <div className="mb-4">
        <UsageBreakdownChart
          entries={agents}
          kind="agent"
          periodLabel="All time"
          title="Usage by coding agent"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => {
          const share = totalTokens ? (agent.tokens / totalTokens) * 100 : 0;
          return (
            <Link
              key={agent.name}
              to={`/agents/${encodeURIComponent(agent.name)}`}
              className="surface-card group p-5 transition hover:-translate-y-0.5 hover:border-primary/40"
            >
              <div className="flex items-center gap-3">
                <AgentLogo name={agent.name} size="size-10" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold capitalize">{agent.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {compact(agent.tokens)} tokens
                  </p>
                </div>
                <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
              </div>
              <div className="mt-6 flex items-end justify-between gap-3">
                <span className="font-heading text-2xl font-semibold tabular-nums">
                  {money(agent.cost)}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {Math.round(share)}% of tokens
                </span>
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-muted">
                <div
                  className="animate-grow-right h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(2, share)}%` }}
                />
              </div>
            </Link>
          );
        })}
      </div>
      {!agents.length && <EmptyState>No agents match your search.</EmptyState>}
    </PageHeading>
  );
};

export const AgentPage = ({ data }: { data: DashboardSummary }) => {
  const { agentName = "" } = useParams();
  const name = decodeURIComponent(agentName);
  const agent = data.agents.find((item) => item.name === name);
  const detail = data.agentDetails[name];
  if (!agent || !detail) {
    return <EmptyState>Coding agent not found.</EmptyState>;
  }
  return (
    <PageHeading
      description="Coding-agent usage across tracked sessions."
      icon={<AgentLogo name={agent.name} size="size-8" />}
      title={agent.name}
    >
      <section className="grid gap-3 sm:grid-cols-2">
        <Stat
          icon={<Zap />}
          label="Tokens"
          value={compact(agent.tokens)}
          note="Attributed token usage"
        />
        <Stat
          icon={<CircleDollarSign />}
          label="Spend"
          value={money(agent.cost)}
          note="Reported and estimated cost"
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <DailySpendChart daily={detail.daily} periodLabel="All time" />
        <UsageBreakdownChart
          entries={detail.models}
          kind="model"
          periodLabel="All time"
          title="Usage by model"
        />
        <UsageBreakdownChart
          entries={detail.projects}
          kind="project"
          periodLabel="All time"
          title="Usage by project"
        />
      </section>
    </PageHeading>
  );
};
