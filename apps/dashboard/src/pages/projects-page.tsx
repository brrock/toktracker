import type { DashboardSummary } from "@toktracker/shared";
import { Activity, Boxes, CircleDollarSign, Zap } from "lucide-react";
import { useParams } from "react-router-dom";

import { CustomizableView } from "@/components/dashboard/customizable-view";
import { PageHeading } from "@/components/dashboard/page-heading";
import { EmptyState, Metric, Stat } from "@/components/dashboard/primitives";
import { compact, matchesQuery, money, recentDate } from "@/lib/dashboard";
import { Link } from "@/lib/navigation";

const ProjectCards = ({
  projects,
  query,
}: {
  projects: DashboardSummary["projects"];
  query: string;
}) => {
  if (!projects.length) {
    return (
      <EmptyState>
        {query
          ? "No projects match your search."
          : "No workspace-backed usage yet."}
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <Link
          key={project.name}
          to={`/projects/${encodeURIComponent(project.name)}`}
          className="surface-card p-5 transition hover:-translate-y-0.5 hover:border-primary/40"
        >
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
              <Boxes size={18} />
            </span>
            <div className="min-w-0">
              <h3 className="truncate font-semibold">{project.name}</h3>
              <p className="text-xs text-muted-foreground">
                Active {recentDate(project.lastSeen)}
              </p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t pt-4 text-sm">
            <Metric label="Tokens" value={compact(project.tokens)} />
            <Metric label="Spend" value={money(project.cost)} />
            <Metric label="Sessions" value={compact(project.sessions)} />
          </div>
        </Link>
      ))}
    </div>
  );
};

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
    <CustomizableView
      view="projects"
      data={{
        breakdowns: { project: projects },
        periodLabel: "All time",
        slots: {
          "project-cards": <ProjectCards projects={projects} query={query} />,
        },
      }}
      heading={
        <PageHeading
          title="Projects"
          description="Usage grouped by workspace and repository."
        />
      }
    />
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
    <CustomizableView
      view="project"
      data={{
        breakdowns: { agent: detail.agents, model: detail.models },
        daily: detail.daily,
        periodLabel: "All time",
        sessions,
        sessionsTitle: "Project sessions",
        stats: (
          <section className="grid gap-4 sm:grid-cols-3">
            <Stat
              icon={<Zap />}
              label="Tokens"
              value={compact(project.tokens)}
              trend={detail.daily.slice(-14).map((point) => point.tokens)}
              note="All tracked usage"
            />
            <Stat
              icon={<CircleDollarSign />}
              label="Spend"
              value={money(project.cost)}
              trend={detail.daily.slice(-14).map((point) => point.cost)}
              note="Estimated and reported"
            />
            <Stat
              icon={<Activity />}
              label="Sessions"
              value={compact(project.sessions)}
              note="Tracked sessions"
            />
          </section>
        ),
      }}
      heading={
        <PageHeading
          title={project.name}
          description="Project usage and recent sessions."
        />
      }
    />
  );
};
