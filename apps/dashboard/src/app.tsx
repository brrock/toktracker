/* eslint-disable no-use-before-define */
import type {
  DashboardSummary,
  SessionSummary,
  TimeRange,
} from "@toktracker/shared";
import {
  Activity,
  Bot,
  Boxes,
  CircleDollarSign,
  Cpu,
  Home,
  Monitor,
  Moon,
  Search,
  Sparkles,
  Sun,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link as RouterLink,
  Navigate,
  NavLink as RouterNavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { useTheme } from "@/components/theme-provider";
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

const EMPTY_HOURLY: DashboardSummary["hourly"] = [];

const EMPTY_SUMMARY: DashboardSummary = {
  agentDetails: {},
  agents: [],
  daily: [],
  devices: [],
  hourly: EMPTY_HOURLY,
  modelDetails: {},
  models: [],
  projectDetails: {},
  projects: [],
  recentSessions: [],
  totals: {
    cost: 0,
    estimatedCost: 0,
    messages: 0,
    reportedCost: 0,
    sessions: 0,
    tokens: 0,
    unpricedTokens: 0,
  },
};

const RANGE_OPTIONS: { label: string; value: TimeRange }[] = [
  { label: "Today", value: "day" },
  { label: "Last 7 days", value: "week" },
  { label: "This month", value: "month" },
  { label: "This year", value: "year" },
  { label: "All time", value: "all" },
];

const pathWithFilters = (path: string, current: URLSearchParams): string => {
  const [pathname = "/", query = ""] = path.split("?");
  const next = new URLSearchParams(query);
  const devices = current.get("devices");
  if (devices) {
    next.set("devices", devices);
  }
  const agents = current.get("agents");
  if (agents && pathname.startsWith("/sessions")) {
    next.set("agents", agents);
  }
  if (pathname === "/") {
    const range = current.get("range");
    if (range) {
      next.set("range", range);
    }
  }
  const suffix = next.toString();
  return `${pathname}${suffix ? `?${suffix}` : ""}`;
};

const Link = (props: React.ComponentProps<typeof RouterLink>) => {
  const [searchParams] = useSearchParams();
  const to =
    typeof props.to === "string"
      ? pathWithFilters(props.to, searchParams)
      : props.to;
  return <RouterLink {...props} to={to} />;
};

const NavLink = (props: React.ComponentProps<typeof RouterNavLink>) => {
  const [searchParams] = useSearchParams();
  const to =
    typeof props.to === "string"
      ? pathWithFilters(props.to, searchParams)
      : props.to;
  return <RouterNavLink {...props} to={to} />;
};

const NAV_ITEMS = [
  { icon: Home, label: "Overview", to: "/" },
  { icon: Bot, label: "Agents", to: "/agents" },
  { icon: Boxes, label: "Projects", to: "/projects" },
  { icon: Activity, label: "Sessions", to: "/sessions" },
] as const;

const compact = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);

const money = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    currency: "USD",
    minimumFractionDigits: value < 10 ? 2 : 0,
    style: "currency",
  }).format(value);

const recentDate = (timestamp: number): string =>
  timestamp > 0
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
        timestamp
      )
    : "Unknown";

const chartDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" }).format(
    new Date(`${date}T00:00:00`)
  );

const chartHour = (date: string): string =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(new Date(date));

type ChartGranularity = "day" | "month" | "quarter" | "half" | "year";

const padNumber = (value: number): string => value.toString().padStart(2, "0");

const allTimeGranularity = (
  daily: DashboardSummary["daily"]
): ChartGranularity => {
  const first = daily[0]?.date;
  const last = daily.at(-1)?.date;
  if (!first || !last) {
    return "day";
  }
  const start = new Date(`${first}T00:00:00`);
  const end = new Date(`${last}T00:00:00`);
  const months =
    (end.getFullYear() - start.getFullYear()) * 12 +
    end.getMonth() -
    start.getMonth() +
    1;
  if (months <= 2) {
    return "day";
  }
  if (months <= 12) {
    return "month";
  }
  if (months <= 36) {
    return "quarter";
  }
  if (months <= 72) {
    return "half";
  }
  return "year";
};

const bucketDate = (date: string, granularity: ChartGranularity): string => {
  if (granularity === "day") {
    return date;
  }
  const pointDate = new Date(`${date}T00:00:00`);
  const year = pointDate.getFullYear();
  const month = pointDate.getMonth();
  let bucketMonth = 0;
  if (granularity === "month") {
    bucketMonth = month;
  } else if (granularity === "quarter") {
    bucketMonth = Math.floor(month / 3) * 3;
  } else if (granularity === "half") {
    bucketMonth = Math.floor(month / 6) * 6;
  }
  return `${year}-${padNumber(bucketMonth + 1)}-01`;
};

const aggregateChartData = (
  daily: DashboardSummary["daily"],
  granularity: ChartGranularity
): DashboardSummary["daily"] => {
  const buckets = new Map<string, DashboardSummary["daily"][number]>();
  for (const point of daily) {
    const date = bucketDate(point.date, granularity);
    const bucket = buckets.get(date);
    if (bucket) {
      bucket.cost += point.cost;
      bucket.tokens += point.tokens;
    } else {
      buckets.set(date, { ...point, date });
    }
  }
  return [...buckets.values()];
};

const chartPeriodLabel = (
  date: string,
  granularity: ChartGranularity
): string => {
  const pointDate = new Date(`${date}T00:00:00`);
  const year = pointDate.getFullYear();
  if (granularity === "year") {
    return year.toString();
  }
  if (granularity === "half") {
    return `${pointDate.getMonth() < 6 ? "H1" : "H2"} ${year}`;
  }
  if (granularity === "quarter") {
    return `Q${Math.floor(pointDate.getMonth() / 3) + 1} ${year}`;
  }
  if (granularity === "month") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      year: "2-digit",
    }).format(pointDate);
  }
  return chartDate(date);
};

const matchesQuery = (values: string[], query: string): boolean =>
  values.join(" ").toLowerCase().includes(query.trim().toLowerCase());

const AGENT_LOGOS: Record<string, string> = {
  claude: "/agent-logos/client-claude.jpg",
  codex: "/agent-logos/client-openai.jpg",
  copilot: "/agent-logos/client-copilot.jpg",
  hermes: "/agent-logos/client-hermes.png",
  opencode: "/agent-logos/client-opencode.png",
  pi: "/agent-logos/client-pi.png",
};

const AgentLogo = ({
  name,
  size = "size-6",
}: {
  name: string;
  size?: string;
}) => {
  const source = AGENT_LOGOS[name.toLowerCase()];
  return source ? (
    <img src={source} alt="" className={`${size} rounded object-cover`} />
  ) : (
    <span
      className={`grid ${size} place-items-center rounded bg-primary/10 text-primary`}
    >
      <Bot className="size-1/2" />
    </span>
  );
};

const BreakdownIcon = ({
  kind,
  name,
}: {
  kind: "agent" | "model" | "project";
  name: string;
}) => {
  if (kind === "agent") {
    return <AgentLogo name={name} size="size-5" />;
  }
  if (kind === "project") {
    return <Boxes className="size-4 text-primary" />;
  }
  return <Cpu className="size-4 text-primary" />;
};

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border bg-card p-4 text-card-foreground">
    {children}
  </div>
);

const EmptyState = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md border border-dashed py-14 text-center text-sm text-muted-foreground">
    {children}
  </div>
);

const Stat = ({
  icon,
  label,
  note,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  note: string;
  value: string;
}) => (
  <Card>
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
        {icon}
      </span>
    </div>
    <div className="mt-5 truncate text-xl font-semibold tracking-tight">
      {value}
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{note}</p>
  </Card>
);

const ThemeControl = () => {
  const { setTheme, theme } = useTheme();
  const themes = [
    { icon: Sun, label: "Light", value: "light" },
    { icon: Moon, label: "Dark", value: "dark" },
    { icon: Monitor, label: "System", value: "system" },
  ] as const;

  return (
    <div
      className="flex rounded-md border bg-muted p-1"
      aria-label="Color theme"
    >
      {themes.map((option) => {
        const Icon = option.icon;
        const selected = theme === option.value;
        return (
          <button
            type="button"
            key={option.value}
            title={`${option.label} theme`}
            aria-label={`${option.label} theme`}
            aria-pressed={selected}
            onClick={() => setTheme(option.value)}
            className={`grid size-8 place-items-center rounded-lg transition ${selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
};

const DeviceFilter = ({
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
      <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-md border bg-card px-2.5 text-xs [&::-webkit-details-marker]:hidden">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        {label}
        <span className="text-[10px] text-muted-foreground transition group-open:rotate-180">
          ⌄
        </span>
      </summary>
      <div className="absolute right-0 top-10 z-30 w-64 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg">
        <button
          type="button"
          onClick={() => setSelectedIds([])}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
        >
          <span className="grid size-4 place-items-center rounded border text-[11px]">
            {selectedIds.length === 0 ? "✓" : ""}
          </span>
          All devices
        </button>
        <div className="my-1 border-t" />
        <div className="max-h-64 overflow-y-auto">
          {devices.map((device) => (
            <label
              key={device.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.has(device.id)}
                onChange={() => toggle(device.id)}
                className="size-4 accent-primary"
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

const AgentFilter = ({
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
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border bg-card px-3 text-sm [&::-webkit-details-marker]:hidden">
        <Bot size={15} className="text-muted-foreground" />
        {label}
        <span className="text-[10px] text-muted-foreground transition group-open:rotate-180">
          ⌄
        </span>
      </summary>
      <div className="absolute right-0 top-11 z-30 w-64 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg">
        <button
          type="button"
          onClick={() => setSelectedNames([])}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
        >
          <span className="grid size-4 place-items-center rounded border text-[11px]">
            {selectedNames.length === 0 ? "✓" : ""}
          </span>
          All coding agents
        </button>
        <div className="my-1 border-t" />
        <div className="max-h-64 overflow-y-auto">
          {agents.map((agent) => (
            <label
              key={agent.name}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.has(agent.name)}
                onChange={() => toggle(agent.name)}
                className="size-4 accent-primary"
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

const Navigation = ({
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

const CommandPalette = ({
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
        const response = await fetch(`/api/v1/sessions/search?${params}`, {
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
                value={`session ${session.title ?? ""} ${session.project} ${session.id} ${session.model}`}
                onSelect={() =>
                  goTo(`/sessions/${encodeURIComponent(session.id)}`)
                }
              >
                <Activity />
                {session.title ?? session.id}
                <CommandShortcut>{session.project}</CommandShortcut>
              </CommandItem>
            )
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
};

const DailySpendChart = ({
  daily,
  hourly = EMPTY_HOURLY,
  periodLabel,
  range,
  title = "Spend over time",
}: {
  daily: DashboardSummary["daily"];
  hourly?: DashboardSummary["hourly"];
  periodLabel: string;
  range?: TimeRange;
  title?: string;
}) => {
  const [metric, setMetric] = useState<"tokens" | "cost">("cost");
  const isHourly = range === "day";
  const isAllTime = range === "all";
  const granularity = isAllTime ? allTimeGranularity(daily) : "day";
  let chartData = daily.slice(-30);
  if (isHourly) {
    chartData = hourly.slice(-24);
  } else if (isAllTime) {
    chartData = aggregateChartData(daily, granularity);
  }
  const maximumValue = Math.max(...chartData.map((point) => point[metric]), 1);
  const labelInterval = Math.max(1, Math.ceil(chartData.length / 6));
  const firstDate = chartData[0]?.date;
  const lastDate = chartData.at(-1)?.date;
  let dateRange = periodLabel;
  if (firstDate && lastDate) {
    dateRange = isHourly
      ? `${chartHour(firstDate)} – ${chartHour(lastDate)}`
      : `${chartDate(firstDate)} – ${chartDate(lastDate)}`;
  }
  const formatValue = (value: number): string =>
    metric === "cost" ? money(value) : compact(value);
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {isHourly
              ? "Hourly"
              : `${granularity === "day" ? "Daily" : `${granularity[0]?.toUpperCase()}${granularity.slice(1)}`} `}
            {metric === "cost" ? "tracked spend" : "token usage"} · {dateRange}
          </p>
        </div>
        <select
          aria-label="Chart metric"
          value={metric}
          onChange={(event) =>
            setMetric(event.target.value as "tokens" | "cost")
          }
          className="h-8 rounded-md border bg-background px-2 text-xs font-medium"
        >
          <option value="cost">Cost</option>
          <option value="tokens">Tokens</option>
        </select>
      </div>
      {chartData.length ? (
        <div className="mt-7 flex h-60 items-end gap-1.5">
          {chartData.map((point, index) => {
            const showLabel =
              index % labelInterval === 0 || index === chartData.length - 1;
            const label = isHourly
              ? chartHour(point.date)
              : chartPeriodLabel(point.date, granularity);
            return (
              <div
                key={point.date}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                <div className="group relative flex min-h-0 flex-1 items-end">
                  <div
                    title={`${point.date} ${formatValue(point[metric])}`}
                    className="w-full rounded-t bg-primary/20 transition hover:bg-primary"
                    style={{
                      height: `${Math.max(4, (point[metric] / maximumValue) * 100)}%`,
                    }}
                  />
                  <span className="absolute left-1/2 top-0 z-10 hidden -translate-x-1/2 rounded bg-popover px-1.5 py-1 text-[10px] shadow group-hover:block">
                    {formatValue(point[metric])}
                  </span>
                </div>
                <span className="mt-2 h-4 overflow-visible whitespace-nowrap text-center text-[9px] text-muted-foreground">
                  {showLabel ? label : ""}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-6">
          <EmptyState>No usage data for this selection.</EmptyState>
        </div>
      )}
    </Card>
  );
};

const UsageBreakdownChart = ({
  entries,
  kind,
  periodLabel,
  title,
}: {
  entries: { name: string; tokens: number; cost: number }[];
  kind: "agent" | "model" | "project";
  periodLabel: string;
  title: string;
}) => {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const ranked = entries
    .toSorted((left, right) => right[metric] - left[metric])
    .slice(0, 6);
  const maximum = ranked[0]?.[metric] ?? 1;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {metric === "tokens" ? "Token usage" : "Tracked spend"} ·{" "}
            {periodLabel}
          </p>
        </div>
        <select
          value={metric}
          aria-label={`${title} metric`}
          onChange={(event) =>
            setMetric(event.target.value as "tokens" | "cost")
          }
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="tokens">Tokens</option>
          <option value="cost">Cost</option>
        </select>
      </div>
      <div className="mt-6 space-y-4">
        {ranked.map((entry) => (
          <div key={entry.name}>
            <div className="mb-2 flex items-center gap-2 text-sm">
              <BreakdownIcon kind={kind} name={entry.name} />
              <span
                className={`min-w-0 flex-1 truncate font-medium${kind === "model" ? "" : " capitalize"}`}
              >
                {entry.name}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {metric === "tokens"
                  ? compact(entry.tokens)
                  : money(entry.cost)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${Math.max(3, (entry[metric] / maximum) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
        {!ranked.length && (
          <EmptyState>No usage data for this selection.</EmptyState>
        )}
      </div>
    </Card>
  );
};

const OverviewPage = ({
  data,
  range,
  setRange,
}: {
  data: DashboardSummary;
  range: TimeRange;
  setRange: (range: TimeRange) => void;
}) => {
  const [modelMetric, setModelMetric] = useState<"tokens" | "cost">("tokens");
  const periodLabel =
    RANGE_OPTIONS.find((option) => option.value === range)?.label ??
    "This month";
  const rankedModels = [...data.models].toSorted(
    (left, right) => right[modelMetric] - left[modelMetric]
  );
  const maximumModelValue = rankedModels[0]?.[modelMetric] ?? 1;

  return (
    <>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Good morning</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Here’s what your agents have been up to.
          </p>
        </div>
        <label className="sr-only" htmlFor="overview-range">
          Usage period
        </label>
        <select
          id="overview-range"
          value={range}
          onChange={(event) => setRange(event.target.value as TimeRange)}
          className="h-9 rounded-md border bg-card px-3 text-xs font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/30"
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<CircleDollarSign />}
          label="Tracked spend"
          value={money(data.totals.cost)}
          note={`${money(data.totals.reportedCost)} reported · ${money(data.totals.estimatedCost)} estimated${data.totals.unpricedTokens ? ` · ${compact(data.totals.unpricedTokens)} unpriced tokens` : ""}`}
        />
        <Stat
          icon={<Zap />}
          label="Tokens used"
          value={compact(data.totals.tokens)}
          note={`${compact(data.totals.messages)} messages`}
        />
        <Stat
          icon={<Activity />}
          label="Sessions"
          value={compact(data.totals.sessions)}
          note="Tracked sessions"
        />
        <Stat
          icon={<Cpu />}
          label="Top model"
          value={data.models[0]?.name ?? "No data yet"}
          note={
            data.models[0]
              ? `${compact(data.models[0].tokens)} tokens`
              : "Start the client to sync"
          }
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <DailySpendChart
          daily={data.daily}
          hourly={data.hourly}
          periodLabel={periodLabel}
          range={range}
        />
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Usage by model</h3>
              <p className="text-sm text-muted-foreground">
                Rank models by tokens or cost
              </p>
            </div>
            <label className="sr-only" htmlFor="model-metric">
              Model ranking
            </label>
            <select
              id="model-metric"
              value={modelMetric}
              onChange={(event) =>
                setModelMetric(event.target.value as "tokens" | "cost")
              }
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="tokens">Tokens</option>
              <option value="cost">Cost</option>
            </select>
          </div>
          <div className="mt-6 space-y-5">
            {rankedModels.slice(0, 5).map((model) => (
              <div key={model.name}>
                <div className="mb-2 flex justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{model.name}</span>
                  <span className="text-muted-foreground">
                    {modelMetric === "tokens"
                      ? compact(model.tokens)
                      : money(model.cost)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.max(5, (model[modelMetric] / maximumModelValue) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            {!data.models.length && <EmptyState>No model data yet.</EmptyState>}
          </div>
        </Card>
      </section>
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <UsageBreakdownChart
          entries={data.agents}
          kind="agent"
          periodLabel={periodLabel}
          title="Usage by coding agent"
        />
        <UsageBreakdownChart
          entries={data.projects}
          kind="project"
          periodLabel={periodLabel}
          title="Usage by project"
        />
      </section>
      <section className="mt-5">
        <SessionTable
          sessions={data.recentSessions.slice(0, 6)}
          title="Recent sessions"
        />
      </section>
    </>
  );
};

const AgentsPage = ({
  data,
  query,
}: {
  data: DashboardSummary;
  query: string;
}) => {
  const agents = data.agents.filter((agent) =>
    matchesQuery([agent.name], query)
  );
  return (
    <PageHeading
      title="Agents"
      description="Token and spend attribution across coding agents."
    >
      <div className="mb-4">
        <UsageBreakdownChart
          entries={agents}
          kind="agent"
          periodLabel="All time"
          title="Usage by coding agent"
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <Link
            key={agent.name}
            to={`/agents/${encodeURIComponent(agent.name)}`}
            className="rounded-lg border bg-card p-4 transition hover:border-primary/40"
          >
            <div className="flex items-center gap-3">
              <AgentLogo name={agent.name} size="size-10" />
              <div>
                <h3 className="font-semibold capitalize">{agent.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {compact(agent.tokens)} tokens
                </p>
              </div>
            </div>
            <div className="mt-6 text-2xl font-semibold">
              {money(agent.cost)}
            </div>
          </Link>
        ))}
      </div>
      {!agents.length && <EmptyState>No agents match your search.</EmptyState>}
    </PageHeading>
  );
};

const AgentPage = ({ data }: { data: DashboardSummary }) => {
  const { agentName = "" } = useParams();
  const name = decodeURIComponent(agentName);
  const agent = data.agents.find((item) => item.name === name);
  const detail = data.agentDetails[name];
  if (!agent || !detail) {
    return <EmptyState>Coding agent not found.</EmptyState>;
  }
  return (
    <PageHeading
      title={agent.name}
      description="Coding-agent usage across tracked sessions."
    >
      <section className="grid gap-3 sm:grid-cols-2">
        <Stat
          icon={<Zap />}
          label="Tokens"
          value={compact(agent.tokens)}
          note="Attributed token usage"
        />
        <Stat
          icon={<CircleDollarSign />}
          label="Spend"
          value={money(agent.cost)}
          note="Reported and estimated cost"
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <DailySpendChart daily={detail.daily} periodLabel="All time" />
        <UsageBreakdownChart
          entries={detail.models}
          kind="model"
          periodLabel="All time"
          title="Usage by model"
        />
        <UsageBreakdownChart
          entries={detail.projects}
          kind="project"
          periodLabel="All time"
          title="Usage by project"
        />
      </section>
    </PageHeading>
  );
};

const ProjectsPage = ({
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
        <EmptyState>No projects match your search.</EmptyState>
      )}
    </PageHeading>
  );
};

const ProjectPage = ({ data }: { data: DashboardSummary }) => {
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

const SessionsPage = ({
  data,
  deviceParam,
  query,
}: {
  data: DashboardSummary;
  deviceParam: string;
  query: string;
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAgentNames = (searchParams.get("agents") ?? "")
    .split(",")
    .filter(Boolean);
  const agentParam = selectedAgentNames.join(",");
  const [allSessions, setAllSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const loadSessions = async (): Promise<void> => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "all" });
        if (deviceParam) {
          params.set("devices", deviceParam);
        }
        if (agentParam) {
          params.set("agents", agentParam);
        }
        const response = await fetch(`/api/v1/sessions/search?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Sessions request failed");
        }
        setAllSessions((await response.json()) as SessionSummary[]);
      } catch {
        if (!controller.signal.aborted) {
          setAllSessions([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    loadSessions();
    return () => controller.abort();
  }, [agentParam, deviceParam]);

  const setSelectedAgentNames = (names: string[]): void => {
    setSearchParams((current) => {
      const updated = new URLSearchParams(current);
      if (names.length > 0) {
        updated.set("agents", names.join(","));
      } else {
        updated.delete("agents");
      }
      return updated;
    });
  };
  const sessions = allSessions.filter((session) =>
    matchesQuery(
      [
        session.title ?? "",
        session.id,
        session.project,
        session.model,
        session.client,
      ],
      query
    )
  );

  return (
    <PageHeading
      title="Sessions"
      description="All coding sessions across every selected device."
    >
      <div className="mb-4 flex justify-end">
        <AgentFilter
          agents={data.agents}
          selectedNames={selectedAgentNames}
          setSelectedNames={setSelectedAgentNames}
        />
      </div>
      {loading ? (
        <EmptyState>Loading sessions…</EmptyState>
      ) : (
        <SessionTable sessions={sessions} title="All sessions" />
      )}
    </PageHeading>
  );
};

const SessionPage = ({
  data,
  deviceParam,
}: {
  data: DashboardSummary;
  deviceParam: string;
}) => {
  const { sessionId = "" } = useParams();
  const id = decodeURIComponent(sessionId);
  const recentSession = data.recentSessions.find((item) => item.id === id);
  const [loadedSession, setLoadedSession] = useState<{
    id: string;
    session?: SessionSummary;
  }>({ id: "" });

  useEffect(() => {
    if (recentSession) {
      return;
    }
    const controller = new AbortController();
    const loadSession = async (): Promise<void> => {
      try {
        const params = new URLSearchParams();
        if (deviceParam) {
          params.set("devices", deviceParam);
        }
        const response = await fetch(
          `/api/v1/sessions/${encodeURIComponent(id)}?${params}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error("Session request failed");
        }
        setLoadedSession({
          id,
          session: (await response.json()) as SessionSummary,
        });
      } catch {
        if (!controller.signal.aborted) {
          setLoadedSession({ id });
        }
      }
    };
    loadSession();
    return () => controller.abort();
  }, [deviceParam, id, recentSession]);

  const session =
    recentSession ??
    (loadedSession.id === id ? loadedSession.session : undefined);
  if (!recentSession && loadedSession.id !== id) {
    return <EmptyState>Loading session…</EmptyState>;
  }
  if (!session) {
    return <EmptyState>Session not found.</EmptyState>;
  }
  return (
    <PageHeading
      title={session.title ?? session.id}
      description={`${session.project} · ${session.id}`}
    >
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<Zap />}
          label="Tokens"
          value={compact(session.tokens)}
          note="Total token usage"
        />
        <Stat
          icon={<CircleDollarSign />}
          label="Spend"
          value={money(session.cost)}
          note="Session cost"
        />
        <Stat
          icon={<Bot />}
          label="Agent"
          value={session.client}
          note="Source client"
        />
        <Stat
          icon={<Cpu />}
          label="Model"
          value={session.model}
          note="Primary model"
        />
      </section>
    </PageHeading>
  );
};

const ModelPage = ({ data }: { data: DashboardSummary }) => {
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
    <PageHeading
      title={model.name}
      description="Model usage across coding agents and projects."
    >
      <section className="grid gap-3 sm:grid-cols-2">
        <Stat
          icon={<Zap />}
          label="Tokens"
          value={compact(model.tokens)}
          note="Tracked model tokens"
        />
        <Stat
          icon={<CircleDollarSign />}
          label="Spend"
          value={money(model.cost)}
          note="Reported and estimated"
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
          entries={detail.projects}
          kind="project"
          periodLabel="All time"
          title="Usage by project"
        />
      </section>
    </PageHeading>
  );
};

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="font-semibold">{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

const PageHeading = ({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) => (
  <>
    <div className="mb-5">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
    {children}
  </>
);

const SessionTable = ({
  sessions,
  title,
}: {
  sessions: DashboardSummary["recentSessions"];
  title: string;
}) => (
  <Card>
    <div className="mb-5 flex items-center justify-between">
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">Latest tracked activity</p>
      </div>
      <Link to="/sessions" className="text-sm font-medium text-primary">
        View all
      </Link>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="pb-3 font-medium">Project / session</th>
            <th className="whitespace-nowrap pb-3 pl-6 font-medium">Agent</th>
            <th className="whitespace-nowrap pb-3 pl-6 font-medium">Tokens</th>
            <th className="whitespace-nowrap pb-3 pl-6 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="border-b last:border-0">
              <td className="py-4">
                <Link
                  to={`/sessions/${encodeURIComponent(session.id)}`}
                  className="font-medium hover:text-primary"
                >
                  {session.title ?? session.id}
                </Link>
                <div className="max-w-56 truncate text-xs text-muted-foreground">
                  {session.project}
                </div>
              </td>
              <td className="whitespace-nowrap py-4 pl-6 text-muted-foreground">
                <span className="flex items-center gap-2 capitalize">
                  <AgentLogo name={session.client} size="size-5" />
                  {session.client}
                </span>
              </td>
              <td className="whitespace-nowrap py-4 pl-6 text-muted-foreground">
                {compact(session.tokens)}
              </td>
              <td className="whitespace-nowrap py-4 pl-6 text-right font-medium">
                {money(session.cost)}
              </td>
            </tr>
          ))}
          {!sessions.length && (
            <tr>
              <td
                colSpan={4}
                className="py-12 text-center text-muted-foreground"
              >
                No sessions found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </Card>
);

const App = () => {
  const [data, setData] = useState(EMPTY_SUMMARY);
  const [overviewData, setOverviewData] = useState(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const requestedRange = searchParams.get("range");
  const range = RANGE_OPTIONS.some((option) => option.value === requestedRange)
    ? (requestedRange as TimeRange)
    : "month";
  const selectedDeviceIds = (searchParams.get("devices") ?? "")
    .split(",")
    .filter(Boolean);
  const deviceParam = selectedDeviceIds.join(",");
  const updateSearchParam = useCallback(
    (key: string, value?: string): void => {
      setSearchParams((current) => {
        const updated = new URLSearchParams(current);
        if (value) {
          updated.set(key, value);
        } else {
          updated.delete(key);
        }
        return updated;
      });
    },
    [setSearchParams]
  );

  useEffect(() => {
    if (location.pathname === "/" && requestedRange !== range) {
      updateSearchParam("range", range);
      return;
    }
    if (location.pathname !== "/" && requestedRange) {
      updateSearchParam("range");
    }
  }, [location.pathname, range, requestedRange, updateSearchParam]);

  useEffect(() => {
    const controller = new AbortController();
    const loadSummary = async (): Promise<void> => {
      try {
        const overviewRequest = new URLSearchParams({ range });
        const globalRequest = new URLSearchParams({ range: "all" });
        if (deviceParam) {
          overviewRequest.set("devices", deviceParam);
          globalRequest.set("devices", deviceParam);
        }
        const [overviewResponse, globalResponse] = await Promise.all([
          fetch(`/api/v1/summary?${overviewRequest}`, {
            signal: controller.signal,
          }),
          fetch(`/api/v1/summary?${globalRequest}`, {
            signal: controller.signal,
          }),
        ]);
        if (!overviewResponse.ok || !globalResponse.ok) {
          throw new Error("Summary request failed");
        }
        const [overviewSummary, globalSummary] = await Promise.all([
          overviewResponse.json() as Promise<DashboardSummary>,
          globalResponse.json() as Promise<DashboardSummary>,
        ]);
        setOverviewData(overviewSummary);
        setData(globalSummary);
      } catch {
        if (!controller.signal.aborted) {
          setData(EMPTY_SUMMARY);
          setOverviewData(EMPTY_SUMMARY);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    loadSummary();
    return () => controller.abort();
  }, [deviceParam, range]);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  const pageTitle = useMemo(() => {
    const navigationTitle = NAV_ITEMS.find(
      (item) => item.to === location.pathname
    )?.label;
    if (navigationTitle) {
      return navigationTitle;
    }
    if (location.pathname.startsWith("/agents/")) {
      return "Agent details";
    }
    if (location.pathname.startsWith("/projects/")) {
      return "Project details";
    }
    if (location.pathname.startsWith("/models/")) {
      return "Model details";
    }
    if (location.pathname.startsWith("/sessions/")) {
      return "Session details";
    }
    return "TokTracker";
  }, [location.pathname]);

  useEffect(() => {
    document.title =
      pageTitle === "TokTracker" ? pageTitle : `${pageTitle} | TokTracker`;
  }, [pageTitle]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <CommandPalette
        data={data}
        deviceParam={deviceParam}
        open={searchOpen}
        onOpenChange={setSearchOpen}
      />
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r bg-card px-4 py-5 lg:flex">
        <Link to="/" className="flex items-center gap-3 px-2">
          <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Zap size={19} />
          </div>
          <div>
            <div className="font-semibold tracking-tight">TokTracker</div>
            <div className="text-xs text-muted-foreground">
              Usage intelligence
            </div>
          </div>
        </Link>
        <Navigation data={data} />
        <div className="mt-auto flex items-center gap-2 rounded-md border bg-primary/5 px-2.5 py-2 text-xs font-medium">
          <Sparkles size={13} className="text-primary" /> Gateway online
        </div>
      </aside>
      <main className="lg:pl-56">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background/90 px-5 backdrop-blur md:px-8">
          <div className="hidden md:block">
            <h1 className="text-lg font-semibold">{pageTitle}</h1>
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="mx-auto flex h-9 w-full max-w-xl items-center gap-2 rounded-md border bg-muted px-3 text-sm text-muted-foreground transition hover:bg-background hover:text-foreground"
          >
            <Search size={15} />
            <span className="truncate">
              Search agents, projects, models, sessions…
            </span>
            <kbd className="ml-auto hidden rounded border bg-background px-1.5 py-0.5 text-[10px] font-medium sm:inline">
              ⌘K
            </kbd>
          </button>
          <ThemeControl />
          <DeviceFilter
            devices={data.devices}
            selectedIds={selectedDeviceIds}
            setSelectedIds={(ids) =>
              updateSearchParam("devices", ids.join(","))
            }
          />
        </header>
        <Navigation data={data} mobile />
        <div className="mx-auto max-w-[1600px] p-4 md:p-6">
          {loading ? (
            <EmptyState>Loading usage…</EmptyState>
          ) : (
            <Routes>
              <Route
                path="/"
                element={
                  <OverviewPage
                    data={overviewData}
                    range={range}
                    setRange={(nextRange) =>
                      updateSearchParam("range", nextRange)
                    }
                  />
                }
              />
              <Route
                path="/agents"
                element={<AgentsPage data={data} query="" />}
              />
              <Route
                path="/agents/:agentName"
                element={<AgentPage data={data} />}
              />
              <Route
                path="/projects"
                element={<ProjectsPage data={data} query="" />}
              />
              <Route
                path="/projects/:projectName"
                element={<ProjectPage data={data} />}
              />
              <Route
                path="/models/:modelName"
                element={<ModelPage data={data} />}
              />
              <Route
                path="/sessions"
                element={
                  <SessionsPage
                    data={data}
                    deviceParam={deviceParam}
                    query=""
                  />
                }
              />
              <Route
                path="/sessions/:sessionId"
                element={<SessionPage data={data} deviceParam={deviceParam} />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
