import type { DashboardSummary } from "@toktracker/shared";
import { Activity, Boxes, CircleDollarSign, Zap } from "lucide-react";
import { useParams } from "react-router-dom";

import {
  DailySpendChart,
  UsageBreakdownChart,
} from "@/components/dashboard/charts";
import { PageHeading } from "@/components/dashboard/page-heading";
import { EmptyState, Metric, Stat } from "@/components/dashboard/primitives";
import { SessionTable } from "@/components/dashboard/session-table";
import { compact, matchesQuery, money, recentDate } from "@/lib/dashboard";
import { Link } from "@/lib/navigation";

export const ProjectsPage = ({
  data,
  query,
}: {
  data: DashboardSummary;
  query: string;
}) => {
  const projects = data.projects.filter((project) =>
    matchesQuery([project.name], query)
  );
  return (
    <PageHeading
      title="Projects"
      description="Usage grouped by workspace and repository."
    >
      <div className="mb-4">
        <UsageBreakdownChart
          entries={projects}
          kind="project"
          periodLabel="All time"
          title="Usage by project"
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <Link
            key={project.name}
            to={`/projects/${encodeURIComponent(project.name)}`}
            className="rounded-lg border bg-card p-4 transition hover:border-primary/40 hover:shadow-md"
          >
            <div className="flex items-center gap-3">
              <Boxes className="text-primary" size={19} />
              <div className="min-w-0">
                <h3 className="truncate font-semibold">{project.name}</h3>
                <p className="text-xs text-muted-foreground">
                  Active {recentDate(project.lastSeen)}
                </p>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-3 gap-3 text-sm">
              <Metric label="Tokens" value={compact(project.tokens)} />
              <Metric label="Spend" value={money(project.cost)} />
              <Metric label="Sessions" value={compact(project.sessions)} />
            </div>
          </Link>
        ))}
      </div>
      {!projects.length && (
        <EmptyState>
          {query
            ? "No projects match your search."
            : "No workspace-backed usage yet."}
        </EmptyState>
      )}
    </PageHeading>
  );
};

export const ProjectPage = ({ data }: { data: DashboardSummary }) => {
  const { projectName = "" } = useParams();
  const name = decodeURIComponent(projectName);
  const project = data.projects.find((item) => item.name === name);
  const detail = data.projectDetails[name];
  const sessions = data.recentSessions.filter(
    (session) => session.project === name
  );
  if (!project || !detail) {
    return <EmptyState>Project not found.</EmptyState>;
  }
  return (
    <PageHeading
      title={project.name}
      description="Project usage and recent sessions."
    >
      <section className="grid gap-4 sm:grid-cols-3">
        <Stat
          icon={<Zap />}
          label="Tokens"
          value={compact(project.tokens)}
          note="All tracked usage"
        />
        <Stat
          icon={<CircleDollarSign />}
          label="Spend"
          value={money(project.cost)}
          note="Estimated and reported"
        />
        <Stat
          icon={<Activity />}
          label="Sessions"
          value={compact(project.sessions)}
          note="Tracked sessions"
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
          entries={detail.models}
          kind="model"
          periodLabel="All time"
          title="Usage by model"
        />
      </section>
      <div className="mt-5">
        <SessionTable sessions={sessions} title="Project sessions" />
      </div>
    </PageHeading>
  );
};
