import type { DashboardSummary, SessionSort } from "@toktracker/shared";
import {
  CalendarDays,
  Check,
  Download,
  Laptop,
  MonitorSmartphone,
  Plug,
  ShieldBan,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AgentLogo } from "@/components/dashboard/primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { recentDate } from "@/lib/dashboard";
import {
  clientAutoUpdateSettingsSchema,
  dashboardDeviceListSchema,
  dashboardSummarySchema,
  providerDashboardOverviewSchema,
} from "@/lib/schemas";

export type SettingsSection =
  | "general"
  | "devices"
  | "export"
  | "providers"
  | "cursor"
  | "copilot";
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
  cloudAgentApiKeyConfigured?: boolean;
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
interface CloudAgentAccount {
  id: string;
  label: string;
}
type CursorSettings = Omit<CursorOverview, "devices">;
interface CopilotSettings {
  enabled: boolean;
  importDesktop: boolean;
  importOtel: boolean;
  importVsCode: boolean;
  otelExporterFile?: string;
}
interface ProviderOverview {
  cloudAgentAccounts: CloudAgentAccount[];
  copilot: CopilotSettings;
  cursor: CursorSettings;
  devices: CursorDeviceOverview[];
}

const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const rangeLabel = (range: DateRange): string =>
  `${range.from.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} – ${range.to.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
const isOnline = (lastSeen: number): boolean =>
  Date.now() - lastSeen < 5 * 60_000;

type CursorDebugDetails = Record<
  string,
  boolean | number | string | string[] | undefined
>;

const cursorDebug = (event: string, details: CursorDebugDetails): void => {
  if (import.meta.env.DEV) {
    console.info(`[TokTracker Cursor dashboard] ${event}`, details);
  }
};

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
        { icon: Plug, label: "Providers", value: "providers" },
        { icon: MonitorSmartphone, label: "Devices", value: "devices" },
        { icon: Download, label: "Data & export", value: "export" },
      ] as const
    ).map((item) => (
      <button
        type="button"
        key={item.value}
        onClick={() => setSection(item.value)}
        className={`flex items-center gap-3 rounded-md px-3 py-2 text-left transition ${section === item.value || (item.value === "providers" && (section === "cursor" || section === "copilot")) ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
      >
        <item.icon size={15} />
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
  const [providerSettings, setProviderSettings] = useState<ProviderOverview>();
  const [savingCursor, setSavingCursor] = useState(false);
  const [cursorToken, setCursorToken] = useState("");
  const [cloudAgentLabel, setCloudAgentLabel] = useState("");
  const [cloudAgentKey, setCloudAgentKey] = useState("");
  const [cursorAccountApiKey, setCursorAccountApiKey] = useState("");
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
    if (
      section !== "providers" &&
      section !== "cursor" &&
      section !== "copilot"
    ) {
      return;
    }
    const loadProviderSettings = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/v1/settings/providers");
        if (!response.ok) {
          setProviderSettings(undefined);
          return;
        }
        const overview = providerDashboardOverviewSchema.parse(
          await response.json()
        );
        setProviderSettings(overview);
        setCursorDeviceId((current) => {
          if (current) {
            return current;
          }
          return overview.devices[0]?.deviceId ?? "";
        });
      } catch {
        setProviderSettings(undefined);
      }
    };
    void loadProviderSettings();
    // Account actions are executed by the client asynchronously. Refresh this
    // status while the page is open so "queued" becomes visible without a
    // manual browser reload.
    const refreshInterval = window.setInterval(() => {
      void loadProviderSettings();
    }, 5000);
    return () => window.clearInterval(refreshInterval);
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
    const response = await apiFetch("/api/v1/settings/providers");
    if (!response.ok) {
      return;
    }
    const overview = providerDashboardOverviewSchema.parse(
      await response.json()
    );
    setProviderSettings(overview);
    setCursorDeviceId(
      (current) => current || overview.devices[0]?.deviceId || ""
    );
  };
  const saveCursorSettings = async (): Promise<void> => {
    if (!providerSettings) {
      return;
    }
    setSavingCursor(true);
    setCursorMessage("");
    try {
      const response = await apiFetch("/api/v1/settings/providers", {
        body: JSON.stringify({
          copilot: providerSettings.copilot,
          cursor: providerSettings.cursor,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        cursorDebug("settings save failed", { status: response.status });
        setCursorMessage(`Could not save settings (HTTP ${response.status}).`);
        return;
      }
      cursorDebug("settings saved", {
        apiKeyConfigured: Boolean(
          providerSettings.cursor.cloudAgentApiKey?.trim()
        ),
        syncIntervalMs: providerSettings.cursor.syncIntervalMs,
      });
      await refreshCursorSettings();
      setCursorMessage("Saved provider settings.");
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
    if (!response.ok) {
      cursorDebug("action queue failed", { path, status: response.status });
      setCursorMessage(`Could not queue action (HTTP ${response.status}).`);
      return;
    }
    cursorDebug("action queued", { path });
    setCursorToken("");
    setCursorMessage("Queued for the next client scan.");
    await refreshCursorSettings();
  };
  const addCloudAgentAccount = async (): Promise<void> => {
    if (!cloudAgentLabel.trim() || !cloudAgentKey.trim()) {
      return;
    }
    setCursorMessage("");
    const response = await apiFetch(
      "/api/v1/settings/cursor/cloud-agent-accounts",
      {
        body: JSON.stringify({
          apiKey: cloudAgentKey,
          label: cloudAgentLabel,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    // SAFETY: this endpoint returns the documented small sync-result object.
    const body = (await response.json()) as { agents?: number; error?: string };
    if (!response.ok) {
      setCursorMessage(body.error ?? "Could not add Cloud Agent account.");
      return;
    }
    setCloudAgentKey("");
    setCloudAgentLabel("");
    setCursorMessage(`Synced ${body.agents ?? 0} Cloud Agent(s).`);
    await refreshCursorSettings();
  };
  const syncCloudAgentAccount = async (id: string): Promise<void> => {
    setCursorMessage("");
    const response = await apiFetch(
      `/api/v1/settings/cursor/cloud-agent-accounts/${id}/sync`,
      { method: "POST" }
    );
    // SAFETY: this endpoint returns the documented small sync-result object.
    const body = (await response.json()) as { agents?: number; error?: string };
    setCursorMessage(
      response.ok
        ? `Synced ${body.agents ?? 0} Cloud Agent(s).`
        : (body.error ?? "Cloud Agent sync failed.")
    );
  };
  const removeCloudAgentAccount = async (id: string): Promise<void> => {
    const response = await apiFetch(
      `/api/v1/settings/cursor/cloud-agent-accounts/${id}`,
      { method: "DELETE" }
    );
    if (response.ok) {
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
  if (
    section === "providers" ||
    section === "cursor" ||
    section === "copilot"
  ) {
    const providerTitle = {
      copilot: "GitHub Copilot",
      cursor: "Cursor",
      providers: "Providers",
    }[section];
    const selectedDevice =
      providerSettings?.devices.find(
        (device) => device.deviceId === cursorDeviceId
      ) ?? providerSettings?.devices[0];
    return (
      <section className="max-w-3xl">
        <div className="flex items-center gap-3">
          {section === "cursor" ? (
            <AgentLogo name="cursor" size="size-8" />
          ) : (
            <Plug className="size-8 text-muted-foreground" />
          )}
          <h2 className="text-2xl font-semibold tracking-tight">
            {providerTitle}
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {section === "providers"
            ? "Choose a provider to manage its gateway-controlled client settings."
            : "The gateway applies these settings to every opted-in client."}
        </p>
        {section === "providers" && (
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <Link
              to="/settings/providers/cursor"
              className="rounded-lg border bg-card p-5 transition hover:border-primary/50 hover:bg-muted/40"
            >
              <div className="flex items-center gap-3">
                <AgentLogo name="cursor" size="size-6" />
                <span className="font-medium">Cursor</span>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Usage sync, local sessions, Cloud Agents, and account
                management.
              </p>
            </Link>
            <Link
              to="/settings/providers/copilot"
              className="rounded-lg border bg-card p-5 transition hover:border-primary/50 hover:bg-muted/40"
            >
              <div className="font-medium">GitHub Copilot</div>
              <p className="mt-3 text-sm text-muted-foreground">
                OTEL, Desktop, and VS Code imports.
              </p>
            </Link>
          </div>
        )}
        {section === "copilot" && (
          <div className="mt-8 rounded-lg border bg-card p-4">
            <h3 className="font-medium">GitHub Copilot</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose the local Copilot sources imported by every opted-in
              client.
            </p>
            {providerSettings && (
              <div className="mt-4 space-y-2">
                {(
                  [
                    [
                      "enabled",
                      "Enable GitHub Copilot import",
                      "Stops all Copilot discovery on clients.",
                    ],
                    [
                      "importOtel",
                      "Import OTEL JSONL",
                      "Includes ~/.copilot/otel and an optional exporter file.",
                    ],
                    [
                      "importDesktop",
                      "Import Copilot Desktop",
                      "Reads the local Copilot data.db database.",
                    ],
                    [
                      "importVsCode",
                      "Import VS Code chat sessions",
                      "Includes GitHub Copilot chat session JSONL files.",
                    ],
                  ] as const
                ).map(([key, title, description]) => (
                  <label
                    key={key}
                    htmlFor={`copilot-${key}`}
                    className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
                  >
                    <Checkbox
                      id={`copilot-${key}`}
                      checked={providerSettings.copilot[key]}
                      onCheckedChange={(checked) =>
                        setProviderSettings({
                          ...providerSettings,
                          copilot: {
                            ...providerSettings.copilot,
                            [key]: checked === true,
                          },
                        })
                      }
                    />
                    <span>
                      <span className="block text-sm font-medium">{title}</span>
                      <span className="block text-sm text-muted-foreground">
                        {description}
                      </span>
                    </span>
                  </label>
                ))}
                <label
                  htmlFor="copilot-otel-exporter"
                  className="grid gap-1 pt-2 text-sm"
                >
                  OTEL exporter file (optional)
                  <Input
                    id="copilot-otel-exporter"
                    placeholder="/path/to/copilot.jsonl"
                    value={providerSettings.copilot.otelExporterFile ?? ""}
                    onChange={(event) =>
                      setProviderSettings({
                        ...providerSettings,
                        copilot: {
                          ...providerSettings.copilot,
                          otelExporterFile: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <Button
                  disabled={savingCursor}
                  size="sm"
                  onClick={saveCursorSettings}
                >
                  {savingCursor ? "Saving…" : "Save GitHub Copilot settings"}
                </Button>
              </div>
            )}
          </div>
        )}
        {section === "cursor" && (
          <>
            <div className="mt-8 rounded-lg border bg-card p-4">
              <h3 className="font-medium">Sync interval</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                How often clients refresh Cursor usage CSV from Cursor’s API.
              </p>
              {providerSettings && (
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
                      value={Math.round(
                        providerSettings.cursor.syncIntervalMs / 60_000
                      )}
                      onChange={(event) =>
                        setProviderSettings({
                          ...providerSettings,
                          cursor: {
                            ...providerSettings.cursor,
                            syncIntervalMs:
                              Math.max(1, Number(event.target.value)) * 60_000,
                          },
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
                      checked={providerSettings.cursor.useT3CodeLocalSessions}
                      onCheckedChange={(checked) =>
                        setProviderSettings({
                          ...providerSettings,
                          cursor: {
                            ...providerSettings.cursor,
                            includeAutomations: checked === true,
                            includeCloudAgents: true,
                            useT3CodeLocalSessions: checked === true,
                          },
                        })
                      }
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        Use T3 Code for local Cursor sessions
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        Enables local Cursor project names and session titles.
                        Cursor&apos;s usage CSV has no project field, so T3 Code
                        replaces only its local CSV rows; Cloud Agents and
                        Automations remain included.
                      </span>
                    </span>
                  </label>
                  <label
                    htmlFor="cursor-include-cloud"
                    className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
                  >
                    <Checkbox
                      id="cursor-include-cloud"
                      checked={providerSettings.cursor.includeCloudAgents}
                      disabled
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        Include Cloud Agents
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        Cloud Agent rows are included from the usage CSV and
                        their git workspace is fetched from the Cloud Agents
                        API.
                      </span>
                    </span>
                  </label>
                  <label
                    htmlFor="cursor-include-automations"
                    className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
                  >
                    <Checkbox
                      id="cursor-include-automations"
                      checked={providerSettings.cursor.includeAutomations}
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
                  <p className="text-xs text-muted-foreground">
                    Local clients send Cursor session and project metadata from
                    T3 Code. Cloud Agent keys are managed by this gateway below.
                  </p>
                  <label
                    htmlFor="cursor-t3-home"
                    className="grid gap-1 text-sm"
                  >
                    T3 Code home (optional)
                    <Input
                      id="cursor-t3-home"
                      placeholder="~/.t3"
                      value={providerSettings.cursor.t3Home ?? ""}
                      onChange={(event) =>
                        setProviderSettings({
                          ...providerSettings,
                          cursor: {
                            ...providerSettings.cursor,
                            t3Home: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <Button
                    disabled={savingCursor}
                    size="sm"
                    onClick={saveCursorSettings}
                  >
                    {savingCursor ? "Saving…" : "Save provider settings"}
                  </Button>
                </div>
              )}
            </div>
            <div className="mt-6 rounded-lg border bg-card p-4">
              <h3 className="font-medium">Cloud Agent accounts</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Keys stay on this gateway. Sync imports Cloud Agent projects,
                names, and activity; Cursor does not expose token counts through
                this API.
              </p>
              <div className="mt-4 space-y-2">
                {providerSettings?.cloudAgentAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                  >
                    <span>{account.label}</span>
                    <span className="flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => syncCloudAgentAccount(account.id)}
                      >
                        Sync
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => removeCloudAgentAccount(account.id)}
                      >
                        Remove
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-3">
                <label
                  htmlFor="cloud-agent-label"
                  className="grid gap-1 text-sm"
                >
                  Account label
                  <Input
                    id="cloud-agent-label"
                    placeholder="Work"
                    value={cloudAgentLabel}
                    onChange={(event) => setCloudAgentLabel(event.target.value)}
                  />
                </label>
                <label htmlFor="cloud-agent-key" className="grid gap-1 text-sm">
                  Cloud Agents API key
                  <Input
                    id="cloud-agent-key"
                    type="password"
                    autoComplete="off"
                    placeholder="Cursor Dashboard → API Keys"
                    value={cloudAgentKey}
                    onChange={(event) => setCloudAgentKey(event.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!cloudAgentLabel.trim() || !cloudAgentKey.trim()}
                  onClick={addCloudAgentAccount}
                >
                  Add and sync account
                </Button>
              </div>
              {cursorMessage && (
                <p className="mt-3 text-sm text-muted-foreground">
                  {cursorMessage}
                </p>
              )}
            </div>
            <div className="mt-6 rounded-lg border bg-card p-4">
              <h3 className="font-medium">Auth status</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Status reported by each client after it scans Cursor desktop
                auth.
              </p>
              {!providerSettings?.devices.length && (
                <p className="mt-4 text-sm text-muted-foreground">
                  Waiting for a client. Keep `bun run dev` running so this
                  machine’s Cursor login is imported and reported here.
                </p>
              )}
              {providerSettings?.devices.map((device) => (
                <div
                  key={device.deviceId}
                  className="mt-4 rounded-md border p-3"
                >
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
                          {account.cloudAgentApiKeyConfigured
                            ? " · API key set"
                            : " · no API key"}
                        </span>
                        <span className="flex gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!cursorAccountApiKey}
                            onClick={() =>
                              queueCursorAction(
                                "/api/v1/settings/cursor/accounts/api-key",
                                {
                                  accountId: account.id,
                                  cloudAgentApiKey: cursorAccountApiKey,
                                  deviceId: device.deviceId,
                                }
                              )
                            }
                          >
                            Set API key
                          </Button>
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
                    {(providerSettings?.devices.length
                      ? providerSettings.devices.map((device) => ({
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
                  htmlFor="cursor-account-api-key"
                  className="grid gap-1 text-sm"
                >
                  Cloud Agents API key for this account (optional)
                  <Input
                    id="cursor-account-api-key"
                    type="password"
                    value={cursorAccountApiKey}
                    onChange={(event) =>
                      setCursorAccountApiKey(event.target.value)
                    }
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
                      !cursorToken ||
                      !(selectedDevice?.deviceId ?? cursorDeviceId)
                    }
                    onClick={() =>
                      queueCursorAction("/api/v1/settings/cursor/accounts", {
                        cloudAgentApiKey: cursorAccountApiKey,
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
                      queueCursorAction(
                        "/api/v1/settings/cursor/import-desktop",
                        {
                          deviceId: selectedDevice?.deviceId ?? cursorDeviceId,
                        }
                      )
                    }
                  >
                    Import desktop login
                  </Button>
                </div>
                {cursorMessage && (
                  <p className="text-sm text-muted-foreground">
                    {cursorMessage}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
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
