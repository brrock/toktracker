import type { DashboardSummary } from "@toktracker/shared";
import { Bot, ChevronDown, MonitorSmartphone } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";

import { AgentLogo } from "./primitives";

export const DeviceFilter = ({
  devices,
  selectedIds,
  setSelectedIds,
}: {
  devices: DashboardSummary["devices"];
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
}) => {
  const selected = new Set(selectedIds);
  const label = selectedIds.length
    ? `${selectedIds.length} device${selectedIds.length === 1 ? "" : "s"}`
    : "All devices";
  const toggle = (id: string): void => {
    if (!selectedIds.length) {
      setSelectedIds([id]);
      return;
    }
    setSelectedIds(
      selected.has(id)
        ? selectedIds.filter((deviceId) => deviceId !== id)
        : [...selectedIds, id]
    );
  };

  return (
    <details className="group relative hidden shrink-0 sm:block">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border bg-card px-3 text-xs font-medium transition hover:border-foreground/20 [&::-webkit-details-marker]:hidden">
        <MonitorSmartphone className="size-3.5 text-muted-foreground" />
        {label}
        <ChevronDown className="size-3.5 text-muted-foreground transition group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 top-11 z-30 w-64 rounded-xl border bg-popover p-2 text-popover-foreground shadow-xl">
        <label
          htmlFor="all-devices"
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
        >
          <Checkbox
            id="all-devices"
            checked={selectedIds.length === 0}
            onCheckedChange={() => setSelectedIds([])}
          />
          All devices
        </label>
        <div className="my-1 border-t" />
        <div className="max-h-64 overflow-y-auto">
          {devices.map((device) => (
            <label
              key={device.id}
              htmlFor={`device-${device.id}`}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            >
              <Checkbox
                id={`device-${device.id}`}
                checked={selected.has(device.id)}
                onCheckedChange={() => toggle(device.id)}
              />
              <span className="min-w-0 flex-1 truncate">{device.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {device.platform}
              </span>
            </label>
          ))}
          {!devices.length && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No devices connected.
            </p>
          )}
        </div>
      </div>
    </details>
  );
};

export const AgentFilter = ({
  agents,
  selectedNames,
  setSelectedNames,
}: {
  agents: DashboardSummary["agents"];
  selectedNames: string[];
  setSelectedNames: (names: string[]) => void;
}) => {
  const selected = new Set(selectedNames);
  const label = selectedNames.length
    ? `${selectedNames.length} agent${selectedNames.length === 1 ? "" : "s"}`
    : "All coding agents";
  const toggle = (name: string): void => {
    if (selectedNames.length === 0) {
      setSelectedNames([name]);
      return;
    }
    setSelectedNames(
      selected.has(name)
        ? selectedNames.filter((agentName) => agentName !== name)
        : [...selectedNames, name]
    );
  };

  return (
    <details className="group relative shrink-0">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border bg-card px-3 text-sm font-medium transition hover:border-foreground/20 [&::-webkit-details-marker]:hidden">
        <Bot size={15} className="text-muted-foreground" />
        {label}
        <ChevronDown className="size-3.5 text-muted-foreground transition group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 top-11 z-30 w-64 rounded-xl border bg-popover p-2 text-popover-foreground shadow-xl">
        <label
          htmlFor="all-coding-agents"
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
        >
          <Checkbox
            id="all-coding-agents"
            checked={selectedNames.length === 0}
            onCheckedChange={() => setSelectedNames([])}
          />
          All coding agents
        </label>
        <div className="my-1 border-t" />
        <div className="max-h-64 overflow-y-auto">
          {agents.map((agent) => (
            <label
              key={agent.name}
              htmlFor={`agent-${agent.name}`}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            >
              <Checkbox
                id={`agent-${agent.name}`}
                checked={selected.has(agent.name)}
                onCheckedChange={() => toggle(agent.name)}
              />
              <AgentLogo name={agent.name} size="size-5" />
              <span className="min-w-0 flex-1 truncate capitalize">
                {agent.name}
              </span>
            </label>
          ))}
          {!agents.length && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No coding agents found.
            </p>
          )}
        </div>
      </div>
    </details>
  );
};
