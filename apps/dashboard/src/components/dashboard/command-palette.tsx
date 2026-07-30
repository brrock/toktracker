import type { DashboardSummary, SessionSummary } from "@toktracker/shared";
import { Activity, Boxes, Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { apiFetch } from "@/lib/api";
import { compact, recentDate } from "@/lib/dashboard";
import { NAV_ITEMS, pathWithFilters } from "@/lib/navigation";

import { AgentLogo } from "./primitives";

export const CommandPalette = ({
  data,
  deviceParam,
  onOpenChange,
  open,
}: {
  data: DashboardSummary;
  deviceParam: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionResults, setSessionResults] = useState<SessionSummary[]>([]);
  const trimmedSessionQuery = sessionQuery.trim();

  useEffect(() => {
    if (!trimmedSessionQuery) {
      return;
    }
    const controller = new AbortController();
    const loadSessions = async (): Promise<void> => {
      try {
        const params = new URLSearchParams({ q: trimmedSessionQuery });
        if (deviceParam) {
          params.set("devices", deviceParam);
        }
        const response = await apiFetch(`/api/v1/sessions/search?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Session search request failed");
        }
        setSessionResults((await response.json()) as SessionSummary[]);
      } catch {
        if (!controller.signal.aborted) {
          setSessionResults([]);
        }
      }
    };
    const timeout = window.setTimeout(loadSessions, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [deviceParam, trimmedSessionQuery]);
  const goTo = (path: string): void => {
    navigate(pathWithFilters(path, searchParams));
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search TokTracker"
      description="Search agents, projects, models, and sessions"
    >
      <CommandInput
        placeholder="Search agents, projects, models, sessions…"
        value={sessionQuery}
        onValueChange={setSessionQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {NAV_ITEMS.map((item) => (
            <CommandItem key={item.to} onSelect={() => goTo(item.to)}>
              <item.icon />
              {item.label}
              {item.to === "/" && <CommandShortcut>G H</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Agents">
          {data.agents.map((agent) => (
            <CommandItem
              key={agent.name}
              value={`agent ${agent.name}`}
              onSelect={() => goTo(`/agents/${encodeURIComponent(agent.name)}`)}
            >
              <AgentLogo name={agent.name} size="size-4" />
              {agent.name}
              <CommandShortcut>{compact(agent.tokens)}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Recent projects">
          {data.projects.slice(0, 20).map((project) => (
            <CommandItem
              key={project.name}
              value={`project ${project.name}`}
              onSelect={() =>
                goTo(`/projects/${encodeURIComponent(project.name)}`)
              }
            >
              <Boxes />
              {project.name}
              <CommandShortcut>{recentDate(project.lastSeen)}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Models">
          {data.models.slice(0, 25).map((model) => (
            <CommandItem
              key={model.name}
              value={`model ${model.name}`}
              onSelect={() => goTo(`/models/${encodeURIComponent(model.name)}`)}
            >
              <Cpu />
              {model.name}
              <CommandShortcut>{compact(model.tokens)}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Sessions">
          {(trimmedSessionQuery ? sessionResults : data.recentSessions).map(
            (session) => (
              <CommandItem
                key={session.id}
                value={`session ${session.title ?? ""} ${session.project} ${session.sessionId} ${session.model}`}
                onSelect={() =>
                  goTo(`/sessions/${encodeURIComponent(session.id)}`)
                }
              >
                <Activity />
                {session.title ?? session.sessionId}
                <CommandShortcut>{session.project}</CommandShortcut>
              </CommandItem>
            )
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
};
