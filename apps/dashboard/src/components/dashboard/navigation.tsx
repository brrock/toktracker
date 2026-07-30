import type { DashboardSummary } from "@toktracker/shared";
import { Boxes } from "lucide-react";

import { compact } from "@/lib/dashboard";
import { NAV_ITEMS, NavLink } from "@/lib/navigation";

import { AgentLogo } from "./primitives";

export const Navigation = ({
  data,
  mobile = false,
}: {
  data: DashboardSummary;
  mobile?: boolean;
}) => (
  <nav
    aria-label="Dashboard"
    className={
      mobile
        ? "flex gap-1 overflow-x-auto border-b px-4 py-2 lg:hidden"
        : "mt-6 min-h-0 flex-1 overflow-y-auto text-sm"
    }
  >
    <div className={mobile ? "flex gap-1" : "space-y-1"}>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${isActive ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
            }
          >
            <Icon size={15} />
            {item.label}
          </NavLink>
        );
      })}
    </div>
    {!mobile && data.agents.length > 0 && (
      <div className="mt-6">
        <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Coding agents
        </p>
        <div className="space-y-0.5">
          {data.agents.slice(0, 8).map((agent) => (
            <NavLink
              key={agent.name}
              to={`/agents/${encodeURIComponent(agent.name)}`}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
              }
            >
              <AgentLogo name={agent.name} size="size-5" />
              <span className="truncate">{agent.name}</span>
              <span className="ml-auto text-[10px] tabular-nums">
                {compact(agent.tokens)}
              </span>
            </NavLink>
          ))}
        </div>
      </div>
    )}
    {!mobile && data.projects.length > 0 && (
      <div className="mt-6">
        <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Projects
        </p>
        <div className="space-y-0.5">
          {data.projects.slice(0, 6).map((project) => (
            <NavLink
              key={project.name}
              to={`/projects/${encodeURIComponent(project.name)}`}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
              }
            >
              <Boxes size={13} />
              <span className="truncate">{project.name}</span>
            </NavLink>
          ))}
        </div>
      </div>
    )}
  </nav>
);
