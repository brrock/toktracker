import type { DashboardSummary } from "@toktracker/shared";
import { Boxes } from "lucide-react";

import { compact } from "@/lib/dashboard";
import { NAV_ITEMS, NavLink } from "@/lib/navigation";
import { cn } from "@/lib/utils";

import { AgentLogo } from "./primitives";

const primaryLinkClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
    isActive
      ? "bg-primary/10 font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary [&>svg]:text-primary"
      : "text-muted-foreground hover:bg-muted hover:text-foreground"
  );

const mobileLinkClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    "flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm transition",
    isActive
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground"
  );

const secondaryLinkClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    "group flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition",
    isActive
      ? "bg-primary/10 text-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground"
  );

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-1.5 px-3 text-3xs font-semibold uppercase tracking-caps text-muted-foreground/80">
    {children}
  </p>
);

export const Navigation = ({
  data,
  mobile = false,
}: {
  data: DashboardSummary;
  mobile?: boolean;
}) => {
  const agentTotal = data.agents.reduce((sum, agent) => sum + agent.tokens, 0);
  return (
    <nav
      aria-label="Dashboard"
      className={
        mobile
          ? "flex gap-1 overflow-x-auto border-b bg-background/80 px-4 py-2 backdrop-blur lg:hidden"
          : "-mx-1 mt-7 min-h-0 flex-1 overflow-y-auto px-1 text-sm"
      }
    >
      <div className={mobile ? "flex gap-1" : "space-y-0.5"}>
        {!mobile && <SectionLabel>Workspace</SectionLabel>}
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={mobile ? mobileLinkClass : primaryLinkClass}
            >
              <Icon size={15} />
              {item.label}
            </NavLink>
          );
        })}
      </div>
      {!mobile && data.agents.length > 0 && (
        <div className="mt-7">
          <SectionLabel>Coding agents</SectionLabel>
          <div className="space-y-0.5">
            {data.agents.slice(0, 8).map((agent) => (
              <NavLink
                key={agent.name}
                to={`/agents/${encodeURIComponent(agent.name)}`}
                className={secondaryLinkClass}
              >
                <AgentLogo name={agent.name} size="size-5" />
                <span className="min-w-0 flex-1 truncate capitalize">
                  {agent.name}
                </span>
                <span className="relative h-1 w-8 overflow-hidden rounded-full bg-muted">
                  <span
                    className="absolute inset-y-0 left-0 w-(--bar-size) rounded-full bg-primary/70"
                    style={{
                      "--bar-size": `${agentTotal ? (agent.tokens / agentTotal) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="w-9 text-right text-3xs tabular-nums">
                  {compact(agent.tokens)}
                </span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
      {!mobile && data.projects.length > 0 && (
        <div className="mt-7">
          <SectionLabel>Projects</SectionLabel>
          <div className="space-y-0.5">
            {data.projects.slice(0, 6).map((project) => (
              <NavLink
                key={project.name}
                to={`/projects/${encodeURIComponent(project.name)}`}
                className={secondaryLinkClass}
              >
                <Boxes size={13} className="shrink-0" />
                <span className="truncate">{project.name}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
};

export const ConnectionStatus = ({
  devices,
}: {
  devices: DashboardSummary["devices"];
}) => {
  const count = devices.length;
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/70 px-3 py-2 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          count ? "bg-success" : "bg-muted-foreground/50"
        )}
      />
      {count
        ? `${count} machine${count === 1 ? "" : "s"} connected`
        : "No machines yet"}
    </div>
  );
};
