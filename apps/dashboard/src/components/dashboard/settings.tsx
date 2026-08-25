import type { DashboardSummary, SessionSort } from "@toktracker/shared";
import {
  CalendarDays,
  Check,
  Download,
  Laptop,
  MonitorSmartphone,
  ShieldBan,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AgentLogo } from "@/components/dashboard/primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { recentDate } from "@/lib/dashboard";
import {
  clientAutoUpdateSettingsSchema,
  cursorDashboardOverviewSchema,
  dashboardDeviceListSchema,
  dashboardSummarySchema,
} from "@/lib/schemas";

export type SettingsSection = "general" | "devices" | "export" | "cursor";
interface DashboardDevice {
  createdAt: number;
  id: string;
  lastSeen: number;
  name: string;
}

interface DateRange {
  from: Date;
  to: Date;
}

interface ClientAutoUpdateSettings {
  channel: "nightly" | "stable";
  enabled: boolean;
  windowEndHour: number;
  windowStartHour: number;
}

interface CursorAccountStatus {
  id: string;
  isActive: boolean;
  label?: string;
}

interface CursorDeviceOverview {
  accounts: CursorAccountStatus[];
  desktopEmail?: string;
  desktopSignedIn: boolean;
  deviceId: string;
  lastError?: string;
  lastSyncAt?: number;
  name?: string;
  syncIntervalMs: number;
  updatedAt: number;
}

interface CursorOverview {
  cloudAgentApiKey?: string;
  devices: CursorDeviceOverview[];
  enabled: boolean;
  includeAutomations: boolean;
  includeCloudAgents: boolean;
  syncIntervalMs: number;
  t3Home?: string;
  useT3CodeLocalSessions: boolean;
}

const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const rangeLabel = (range: DateRange): string =>
  `${range.from.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} – ${range.to.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
const isOnline = (lastSeen: number): boolean =>
  Date.now() - lastSeen < 5 * 60_000;

const Calendar = ({
  range,
  setRange,
}: {
  range: DateRange;
  setRange: (range: DateRange) => void;
}) => {
  const [month, setMonth] = useState(() => new Date());
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0
  ).getDate();
  const cells = Array.from(
    { length: firstDay.getDay() + daysInMonth },
    (_, index) => index - firstDay.getDay() + 1
  );
  const selectDay = (day: Date): void => {
    if (day < range.from || (day >= range.from && day <= range.to)) {
      setRange({ from: day, to: day });
      return;
    }
    setRange({ from: range.from, to: day });
  };
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <Button
          aria-label="Previous month"
          size="icon-sm"
          variant="ghost"
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() - 1))
          }
        >
          ‹
        </Button>
        <p className="text-sm font-medium">
          {month.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </p>
        <Button
          aria-label="Next month"
          size="icon-sm"
          variant="ghost"
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() + 1))
          }
        >
          ›
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
          <span key={`${day}-${index}`} className="py-1 text-muted-foreground">
            {day}
          </span>
        ))}
        {cells.map((day, index) => {
          if (day < 1) {
            return <span key={`empty-${index}`} />;
          }
          const date = new Date(month.getFullYear(), month.getMonth(), day);
          const selected = date >= range.from && date <= range.to;
          return (
            <button
              type="button"
              key={dateKey(date)}
              onClick={() => selectDay(date)}
              className={`grid aspect-square place-items-center rounded-md transition ${selected ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const DeviceSelection = ({
  devices,
  selectedIds,
  setSelectedIds,
}: {
  devices: DashboardSummary["devices"];
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
}) => {
  const selected = new Set(selectedIds);
  const toggle = (id: string): void =>
    setSelectedIds(
      selected.has(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id]
    );
  return (
    <div className="space-y-1">
      {devices.map((device) => (
        <label
          key={device.id}
          htmlFor={`export-${device.id}`}
          className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted"
        >
          <Checkbox
            id={`export-${device.id}`}
            checked={selected.has(device.id)}
            onCheckedChange={() => toggle(device.id)}
          />
          <span className="min-w-0 flex-1 truncate text-sm">{device.name}</span>
          <span className="text-xs text-muted-foreground">
            {device.platform}
          </span>
        </label>
      ))}
    </div>
  );
};

export const SettingsNavigation = ({
  section,
  setSection,
}: {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
}) => (
  <nav
    aria-label="Settings"
    className="mt-6 flex min-h-0 flex-1 flex-col text-sm"
  >
    <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      Settings
    </p>
    {(
      [
        { icon: SlidersHorizontal, label: "General", value: "general" },
        { icon: "cursor", label: "Cursor", value: "cursor" },
        { icon: MonitorSmartphone, label: "Devices", value: "devices" },
        { icon: Download, label: "Data & export", value: "export" },
      ] as const
    ).map((item) => (
      <button
        type="button"
        key={item.value}
        onClick={() => setSection(item.value)}
        className={`flex items-center gap-3 rounded-md px-3 py-2 text-left transition ${section === item.value ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
      >
        {item.icon === "cursor" ? (
          <AgentLogo name="cursor" size="size-4" />
        ) : (
          <item.icon size={15} />
        )}
        {item.label}
      </button>
    ))}
  </nav>
);

/* eslint-disable complexity -- settings sections are independent views in one page */
export const SettingsPage = ({
  data,
  section,
  sessionSort,
  setSessionSort,
}: {
  data: DashboardSummary;
  section: SettingsSection;
  sessionSort: SessionSort;
  setSessionSort: (sort: SessionSort) => void;
}) => {
  const [dashboardDevices, setDashboardDevices] = useState<DashboardDevice[]>(
    []
  );
  const [clientAutoUpdate, setClientAutoUpdate] =
    useState<ClientAutoUpdateSettings>();
  const [savingClientAutoUpdate, setSavingClientAutoUpdate] = useState(false);
  const [cursorSettings, setCursorSettings] = useState<CursorOverview>();
  const [savingCursor, setSavingCursor] = useState(false);
  const [cursorToken, setCursorToken] = useState("");
  const [cursorLabel, setCursorLabel] = useState("");
  const [cursorDeviceId, setCursorDeviceId] = useState("");
  const [cursorMessage, setCursorMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    data.devices.map((device) => device.id)
  );
  const today = startOfDay(new Date());
  const [range, setRange] = useState<DateRange>({
    from: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()),
    to: today,
  });
  useEffect(() => {
    if (section !== "general") {
      return;
    }
    const loadClientAutoUpdate = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/v1/settings/client-auto-update");
        setClientAutoUpdate(
          response.ok
            ? clientAutoUpdateSettingsSchema.parse(await response.json())
            : undefined
        );
      } catch {
        setClientAutoUpdate(undefined);
      }
    };
    void loadClientAutoUpdate();
  }, [section]);
  useEffect(() => {
    if (section !== "cursor") {
      return;
    }
    const loadCursorSettings = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/v1/settings/cursor");
        if (!response.ok) {
          setCursorSettings(undefined);
          return;
        }
        const overview = cursorDashboardOverviewSchema.parse(
          await response.json()
        );
        setCursorSettings(overview);
        setCursorDeviceId((current) => {
          if (current) {
            return current;
          }
          return overview.devices[0]?.deviceId ?? "";
        });
      } catch {
        setCursorSettings(undefined);
      }
    };
    void loadCursorSettings();
  }, [section]);
  useEffect(() => {
    if (section !== "devices") {
      return;
    }
    const loadDashboardDevices = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/v1/dashboard-devices");
        setDashboardDevices(
          response.ok
            ? dashboardDeviceListSchema.parse(await response.json())
            : []
        );
      } catch {
        setDashboardDevices([]);
      }
    };
    void loadDashboardDevices();
  }, [section]);
  const download = async (): Promise<void> => {
    const from = dateKey(range.from);
    const to = dateKey(range.to);
    const request = new URLSearchParams({
      devices: selectedIds.join(","),
      range: "all",
    });
    const response = await apiFetch(`/api/v1/summary?${request}`);
    if (!response.ok) {
      return;
    }
    const summary = dashboardSummarySchema.parse(await response.json());
    const daily = summary.daily.filter(
      (point) => point.date >= from && point.date <= to
    );
    const totals = { cost: 0, tokens: 0 };
    for (const point of daily) {
      totals.cost += point.cost;
      totals.tokens += point.tokens;
    }
    const file = new Blob(
      [
        JSON.stringify(
          {
            deviceIds: selectedIds,
            devices: summary.devices,
            exportedAt: new Date().toISOString(),
            range: { from, to },
            recentSessions: summary.recentSessions.filter(
              (session) =>
                session.lastSeen >= range.from.getTime() &&
                session.lastSeen < range.to.getTime() + 86_400_000
            ),
            usage: { daily, totals },
          },
          null,
          2
        ),
      ],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `toktracker-export-${from}-to-${to}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const saveClientAutoUpdate = async (): Promise<void> => {
    if (!clientAutoUpdate) {
      return;
    }
    setSavingClientAutoUpdate(true);
    try {
      const response = await apiFetch("/api/v1/settings/client-auto-update", {
        body: JSON.stringify(clientAutoUpdate),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      if (response.ok) {
        setClientAutoUpdate(
          clientAutoUpdateSettingsSchema.parse(await response.json())
        );
      }
    } finally {
      setSavingClientAutoUpdate(false);
    }
  };
  const refreshCursorSettings = async (): Promise<void> => {
    const response = await apiFetch("/api/v1/settings/cursor");
    if (!response.ok) {
      return;
    }
    const overview = cursorDashboardOverviewSchema.parse(await response.json());
    setCursorSettings(overview);
    setCursorDeviceId(
      (current) => current || overview.devices[0]?.deviceId || ""
    );
  };
  const saveCursorSettings = async (): Promise<void> => {
    if (!cursorSettings) {
      return;
    }
    setSavingCursor(true);
    setCursorMessage("");
    try {
      const response = await apiFetch("/api/v1/settings/cursor", {
        body: JSON.stringify({
          cloudAgentApiKey: cursorSettings.cloudAgentApiKey,
          enabled: cursorSettings.enabled,
          includeAutomations: cursorSettings.includeAutomations,
          includeCloudAgents: cursorSettings.includeCloudAgents,
          syncIntervalMs: cursorSettings.syncIntervalMs,
          t3Home: cursorSettings.t3Home,
          useT3CodeLocalSessions: cursorSettings.useT3CodeLocalSessions,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      if (response.ok) {
        await refreshCursorSettings();
        setCursorMessage("Saved Cursor sync settings.");
      }
    } finally {
      setSavingCursor(false);
    }
  };
  const queueCursorAction = async (
    path: string,
    body: Record<string, string>
  ): Promise<void> => {
    setCursorMessage("");
    const response = await apiFetch(path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (response.ok) {
      setCursorToken("");
      setCursorMessage("Queued for the next client scan.");
      await refreshCursorSettings();
    }
  };
  const revokeDashboardDevice = async (id: string): Promise<void> => {
    const response = await apiFetch(`/api/v1/dashboard-devices/${id}`, {
      method: "DELETE",
    });
    if (response.ok) {
      setDashboardDevices((devices) =>
        devices.filter((device) => device.id !== id)
      );
    }
  };
  const banDevice = async (id: string): Promise<void> => {
    const response = await apiFetch(`/api/v1/devices/${id}`, {
      method: "DELETE",
    });
    if (response.ok) {
      setSelectedIds((ids) => ids.filter((deviceId) => deviceId !== id));
    }
  };
  if (section === "general") {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-semibold tracking-tight">General</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Customize how session activity is displayed.
        </p>
        <div className="mt-8 rounded-lg border bg-card p-4">
          <h3 className="font-medium">Session order</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose how sessions are ordered throughout the dashboard.
          </p>
          <label
            htmlFor="session-sort"
            className="mt-4 flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
          >
            <Checkbox
              id="session-sort"
              checked={sessionSort === "createdAt"}
              onCheckedChange={(checked) =>
                setSessionSort(checked ? "createdAt" : "lastSeen")
              }
            />
            <span>
              <span className="block text-sm font-medium">
                Sort by date created
              </span>
              <span className="block text-sm text-muted-foreground">
                Keep older sessions in their original position when new usage is
                recorded. The creation date is the first activity TokTracker
                recorded for that session.
              </span>
            </span>
          </label>
        </div>
        <div className="mt-6 rounded-lg border bg-card p-4">
          <h3 className="font-medium">Gateway-controlled client updates</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask opted-in clients to install releases only during their local
            maintenance window. Clients can opt out locally at any time.
          </p>
          {clientAutoUpdate && (
            <div className="mt-4 space-y-4">
              <label
                htmlFor="client-auto-update"
                className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
              >
                <Checkbox
                  id="client-auto-update"
                  checked={clientAutoUpdate.enabled}
                  onCheckedChange={(checked) =>
                    setClientAutoUpdate({
                      ...clientAutoUpdate,
                      enabled: checked,
                    })
                  }
                />
                <span>
                  <span className="block text-sm font-medium">
                    Automatically update clients
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Updates are checksum-verified and clients restart after a
                    successful update.
                  </span>
                </span>
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label
                  htmlFor="client-update-channel"
                  className="grid gap-1 text-sm"
                >
                  Channel
                  <select
                    id="client-update-channel"
                    value={clientAutoUpdate.channel}
                    className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                    onChange={(event) =>
                      setClientAutoUpdate({
                        ...clientAutoUpdate,
                        channel: clientAutoUpdateSettingsSchema
                          .pick({
                            channel: true,
                          })
                          .parse({ channel: event.target.value }).channel,
                      })
                    }
                  >
                    <option value="stable">Stable</option>
                    <option value="nightly">Nightly</option>
                  </select>
                </label>
                <label
                  htmlFor="client-update-start-hour"
                  className="grid gap-1 text-sm"
                >
                  Start hour (local)
                  <Input
                    id="client-update-start-hour"
                    min="0"
                    max="23"
                    type="number"
                    value={clientAutoUpdate.windowStartHour}
                    onChange={(event) =>
                      setClientAutoUpdate({
                        ...clientAutoUpdate,
                        windowStartHour: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label
                  htmlFor="client-update-end-hour"
                  className="grid gap-1 text-sm"
                >
                  End hour (local)
                  <Input
                    id="client-update-end-hour"
                    min="0"
                    max="23"
                    type="number"
                    value={clientAutoUpdate.windowEndHour}
                    onChange={(event) =>
                      setClientAutoUpdate({
                        ...clientAutoUpdate,
                        windowEndHour: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <Button
                disabled={savingClientAutoUpdate}
                size="sm"
                onClick={saveClientAutoUpdate}
              >
                {savingClientAutoUpdate ? "Saving…" : "Save update settings"}
              </Button>
            </div>
          )}
        </div>
      </section>
    );
  }
  if (section === "cursor") {
    const selectedDevice =
      cursorSettings?.devices.find(
        (device) => device.deviceId === cursorDeviceId
      ) ?? cursorSettings?.devices[0];
    return (
      <section className="max-w-3xl">
        <div className="flex items-center gap-3">
          <AgentLogo name="cursor" size="size-8" />
          <h2 className="text-2xl font-semibold tracking-tight">Cursor</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Development mode imports your Cursor desktop login automatically.
          Change accounts and how often usage is synced here.
        </p>
        <div className="mt-8 rounded-lg border bg-card p-4">
          <h3 className="font-medium">Sync interval</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            How often clients refresh Cursor usage CSV from Cursor’s API.
          </p>
          {cursorSettings && (
            <div className="mt-4 space-y-4">
              <label
                htmlFor="cursor-sync-minutes"
                className="grid gap-1 text-sm"
              >
                Minutes between syncs
                <Input
                  id="cursor-sync-minutes"
                  min="1"
                  max="1440"
                  type="number"
                  value={Math.round(cursorSettings.syncIntervalMs / 60_000)}
                  onChange={(event) =>
                    setCursorSettings({
                      ...cursorSettings,
                      syncIntervalMs:
                        Math.max(1, Number(event.target.value)) * 60_000,
                    })
                  }
                />
              </label>
              <label
                htmlFor="cursor-t3-local"
                className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
              >
                <Checkbox
                  id="cursor-t3-local"
                  checked={cursorSettings.useT3CodeLocalSessions}
                  onCheckedChange={(checked) =>
                    setCursorSettings({
                      ...cursorSettings,
                      includeAutomations: checked === true,
                      includeCloudAgents: true,
                      useT3CodeLocalSessions: checked === true,
                    })
                  }
                />
                <span>
                  <span className="block text-sm font-medium">
                    Use T3 Code for local Cursor sessions
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Replace only local CSV rows with T3 Code sessions. Cloud
                    Agents and Automations remain included.
                  </span>
                </span>
              </label>
              <label
                htmlFor="cursor-include-cloud"
                className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
              >
                <Checkbox
                  id="cursor-include-cloud"
                  checked={cursorSettings.includeCloudAgents}
                  disabled
                />
                <span>
                  <span className="block text-sm font-medium">
                    Include Cloud Agents
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Cloud Agent rows are included from the usage CSV and their
                    git workspace is fetched from the Cloud Agents API.
                  </span>
                </span>
              </label>
              <label
                htmlFor="cursor-include-automations"
                className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
              >
                <Checkbox
                  id="cursor-include-automations"
                  checked={cursorSettings.includeAutomations}
                  disabled
                />
                <span>
                  <span className="block text-sm font-medium">
                    Include Automations
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Automations are included when T3 Code local sessions are
                    enabled.
                  </span>
                </span>
              </label>
              <label htmlFor="cursor-api-key" className="grid gap-1 text-sm">
                Cloud Agents API key
                <Input
                  id="cursor-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder="Cursor Dashboard → API Keys"
                  value={cursorSettings.cloudAgentApiKey ?? ""}
                  onChange={(event) =>
                    setCursorSettings({
                      ...cursorSettings,
                      cloudAgentApiKey: event.target.value,
                    })
                  }
                />
              </label>
              <label htmlFor="cursor-t3-home" className="grid gap-1 text-sm">
                T3 Code home (optional)
                <Input
                  id="cursor-t3-home"
                  placeholder="~/.t3"
                  value={cursorSettings.t3Home ?? ""}
                  onChange={(event) =>
                    setCursorSettings({
                      ...cursorSettings,
                      t3Home: event.target.value,
                    })
                  }
                />
              </label>
              <Button
                disabled={savingCursor}
                size="sm"
                onClick={saveCursorSettings}
              >
                {savingCursor ? "Saving…" : "Save Cursor settings"}
              </Button>
            </div>
          )}
        </div>
        <div className="mt-6 rounded-lg border bg-card p-4">
          <h3 className="font-medium">Auth status</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Status reported by each client after it scans Cursor desktop auth.
          </p>
          {!cursorSettings?.devices.length && (
            <p className="mt-4 text-sm text-muted-foreground">
              Waiting for a client. Keep `bun run dev` running so this machine’s
              Cursor login is imported and reported here.
            </p>
          )}
          {cursorSettings?.devices.map((device) => (
            <div key={device.deviceId} className="mt-4 rounded-md border p-3">
              <p className="text-sm font-medium">
                {device.name ?? device.deviceId}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Desktop auth:{" "}
                {device.desktopSignedIn
                  ? (device.desktopEmail ?? "signed in")
                  : "not found"}
                {device.lastSyncAt
                  ? ` · Last usage sync ${recentDate(device.lastSyncAt)}`
                  : ""}
              </p>
              {device.lastError && (
                <p className="mt-1 text-xs text-destructive">
                  {device.lastError}
                </p>
              )}
              <ul className="mt-3 space-y-2">
                {device.accounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span>
                      {account.isActive ? "* " : ""}
                      {account.label ?? account.id}
                    </span>
                    <span className="flex gap-2">
                      {!account.isActive && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            queueCursorAction(
                              "/api/v1/settings/cursor/accounts/switch",
                              {
                                accountId: account.id,
                                deviceId: device.deviceId,
                              }
                            )
                          }
                        >
                          Make active
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          queueCursorAction(
                            "/api/v1/settings/cursor/accounts/remove",
                            {
                              accountId: account.id,
                              deviceId: device.deviceId,
                            }
                          )
                        }
                      >
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-lg border bg-card p-4">
          <h3 className="font-medium">Add account</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Import the desktop session again, or paste a
            WorkosCursorSessionToken value.
          </p>
          <div className="mt-4 grid gap-3">
            <label htmlFor="cursor-device" className="grid gap-1 text-sm">
              Client device
              <select
                id="cursor-device"
                value={selectedDevice?.deviceId ?? cursorDeviceId}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                onChange={(event) => setCursorDeviceId(event.target.value)}
              >
                {(cursorSettings?.devices.length
                  ? cursorSettings.devices.map((device) => ({
                      id: device.deviceId,
                      name: device.name ?? device.deviceId,
                    }))
                  : data.devices.map((device) => ({
                      id: device.id,
                      name: device.name,
                    }))
                ).map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </label>
            <label
              htmlFor="cursor-account-label"
              className="grid gap-1 text-sm"
            >
              Label
              <Input
                id="cursor-account-label"
                value={cursorLabel}
                onChange={(event) => setCursorLabel(event.target.value)}
              />
            </label>
            <label
              htmlFor="cursor-account-token"
              className="grid gap-1 text-sm"
            >
              Session token
              <Input
                id="cursor-account-token"
                type="password"
                value={cursorToken}
                onChange={(event) => setCursorToken(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={
                  !cursorToken || !(selectedDevice?.deviceId ?? cursorDeviceId)
                }
                onClick={() =>
                  queueCursorAction("/api/v1/settings/cursor/accounts", {
                    deviceId: selectedDevice?.deviceId ?? cursorDeviceId,
                    label: cursorLabel,
                    token: cursorToken,
                  })
                }
              >
                Add account
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!(selectedDevice?.deviceId ?? cursorDeviceId)}
                onClick={() =>
                  queueCursorAction("/api/v1/settings/cursor/import-desktop", {
                    deviceId: selectedDevice?.deviceId ?? cursorDeviceId,
                  })
                }
              >
                Import desktop login
              </Button>
            </div>
            {cursorMessage && (
              <p className="text-sm text-muted-foreground">{cursorMessage}</p>
            )}
          </div>
        </div>
      </section>
    );
  }
  if (section === "devices") {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-semibold tracking-tight">Devices</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage dashboard access and the devices that send usage data.
        </p>
        <div className="mt-8 grid gap-6">
          <div className="rounded-lg border bg-card">
            <div className="border-b p-4">
              <h3 className="font-medium">Signed-in dashboard devices</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Remove a device to sign it out and revoke its access.
              </p>
            </div>
            {dashboardDevices.map((device) => (
              <div
                key={device.id}
                className="flex items-center gap-3 border-b p-4 last:border-0"
              >
                <Laptop className="size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{device.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Last active {recentDate(device.lastSeen)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => revokeDashboardDevice(device.id)}
                >
                  Sign out
                </Button>
              </div>
            ))}
            {!dashboardDevices.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No signed-in dashboard devices.
              </p>
            )}
          </div>
          <div className="rounded-lg border bg-card">
            <div className="border-b p-4">
              <h3 className="font-medium">Usage devices</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Banned devices can no longer send usage data.
              </p>
            </div>
            {data.devices.map((device) => (
              <div
                key={device.id}
                className="flex items-center gap-3 border-b p-4 last:border-0"
              >
                <span
                  className={`size-2 rounded-full ${isOnline(device.lastSeen) ? "bg-emerald-500" : "bg-muted-foreground"}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{device.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {device.platform} ·{" "}
                    {isOnline(device.lastSeen)
                      ? "Online"
                      : `Last seen ${recentDate(device.lastSeen)}`}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => banDevice(device.id)}
                >
                  <ShieldBan /> Ban
                </Button>
              </div>
            ))}
            {!data.devices.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No usage devices connected.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="max-w-4xl">
      <h2 className="text-2xl font-semibold tracking-tight">Data & export</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose any date range and mix devices to create a JSON export.
      </p>
      <div className="mt-8 grid gap-6 lg:grid-cols-[320px_1fr]">
        <div>
          <Calendar range={range} setRange={setRange} />
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              { days: 7, label: "Last week" },
              { days: 30, label: "Last month" },
              { days: 365, label: "Last 365 days" },
            ].map((option) => (
              <Button
                key={option.days}
                variant="outline"
                size="sm"
                onClick={() =>
                  setRange({
                    from: new Date(
                      today.getTime() - (option.days - 1) * 86_400_000
                    ),
                    to: today,
                  })
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-card">
          <div className="border-b p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-medium">Export selection</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {rangeLabel(range)}
                </p>
              </div>
              <CalendarDays className="size-5 text-muted-foreground" />
            </div>
          </div>
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Devices</p>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() =>
                  setSelectedIds(data.devices.map((device) => device.id))
                }
              >
                Select all
              </button>
            </div>
            <DeviceSelection
              devices={data.devices}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
            />
            <Button
              className="mt-5 w-full"
              disabled={!selectedIds.length}
              onClick={download}
            >
              <Download /> Export JSON{" "}
              {selectedIds.length ? `(${selectedIds.length})` : ""}
            </Button>
            <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3" /> Your export is downloaded directly to
              your device.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
