import type { DashboardSummary } from "@toktracker/shared";
import { CircleDollarSign, Zap } from "lucide-react";
import { useParams } from "react-router-dom";

import { CustomizableView } from "@/components/dashboard/customizable-view";
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
    <CustomizableView
      view="model"
      data={{
        breakdowns: { agent: detail.agents, project: detail.projects },
        daily: detail.daily,
        periodLabel: "All time",
        stats: (
          <section className="grid gap-4 sm:grid-cols-2">
            <Stat
              icon={<Zap />}
              label="Tokens"
              value={compact(model.tokens)}
              trend={detail.daily.slice(-14).map((point) => point.tokens)}
              note="Tracked model tokens"
            />
            <Stat
              icon={<CircleDollarSign />}
              label="Spend"
              value={money(model.cost)}
              trend={detail.daily.slice(-14).map((point) => point.cost)}
              note="Reported and estimated"
            />
          </section>
        ),
      }}
      heading={
        <PageHeading
          title={model.name}
          description="Model usage across coding agents and projects."
        />
      }
    />
  );
};
