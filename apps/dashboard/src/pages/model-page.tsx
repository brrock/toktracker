import type { DashboardSummary } from "@toktracker/shared";
import { CircleDollarSign, Zap } from "lucide-react";
import { useParams } from "react-router-dom";

import {
  DailySpendChart,
  UsageBreakdownChart,
} from "@/components/dashboard/charts";
import { PageHeading } from "@/components/dashboard/page-heading";
import { EmptyState, Stat } from "@/components/dashboard/primitives";
import { compact, money } from "@/lib/dashboard";

export const ModelPage = ({ data }: { data: DashboardSummary }) => {
  const { modelName = "" } = useParams();
  const name = decodeURIComponent(modelName);
  const model = data.models.find((item) => item.name === name);
  const detail = data.modelDetails?.[name] ?? {
    agents: [],
    daily: [],
    models: [],
    projects: [],
  };
  if (!model) {
    return <EmptyState>Model not found.</EmptyState>;
  }
  return (
    <PageHeading
      title={model.name}
      description="Model usage across coding agents and projects."
    >
      <section className="grid gap-3 sm:grid-cols-2">
        <Stat
          icon={<Zap />}
          label="Tokens"
          value={compact(model.tokens)}
          note="Tracked model tokens"
        />
        <Stat
          icon={<CircleDollarSign />}
          label="Spend"
          value={money(model.cost)}
          note="Reported and estimated"
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <DailySpendChart daily={detail.daily} periodLabel="All time" />
        <UsageBreakdownChart
          entries={detail.agents}
          kind="agent"
          periodLabel="All time"
          title="Usage by coding agent"
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
