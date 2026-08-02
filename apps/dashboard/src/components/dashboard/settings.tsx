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

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch } from "@/lib/api";
import { recentDate } from "@/lib/dashboard";

export type SettingsSection = "general" | "devices" | "export";
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
        { icon: MonitorSmartphone, label: "Devices", value: "devices" },
        { icon: Download, label: "Data & export", value: "export" },
      ] as const
    ).map((item) => {
      const Icon = item.icon;
      return (
        <button
          type="button"
          key={item.value}
          onClick={() => setSection(item.value)}
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-left transition ${section === item.value ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          <Icon size={15} />
          {item.label}
        </button>
      );
    })}
  </nav>
);

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
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    data.devices.map((device) => device.id)
  );
  const today = startOfDay(new Date());
  const [range, setRange] = useState<DateRange>({
    from: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()),
    to: today,
  });
  useEffect(() => {
    if (section !== "devices") {
      return;
    }
    const loadDashboardDevices = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/v1/dashboard-devices");
        setDashboardDevices(
          response.ok ? ((await response.json()) as DashboardDevice[]) : []
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
    const summary = (await response.json()) as DashboardSummary;
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
