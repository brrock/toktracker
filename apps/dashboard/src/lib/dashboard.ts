import type { DashboardSummary, TimeRange } from "@toktracker/shared";

export const EMPTY_HOURLY: DashboardSummary["hourly"] = [];

export const EMPTY_SUMMARY: DashboardSummary = {
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

export const RANGE_OPTIONS: { label: string; value: TimeRange }[] = [
  { label: "Today", value: "day" },
  { label: "Last 7 days", value: "week" },
  { label: "This month", value: "month" },
  { label: "This year", value: "year" },
  { label: "All time", value: "all" },
];

export const compact = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
export const money = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    currency: "USD",
    minimumFractionDigits: value < 10 ? 2 : 0,
    style: "currency",
  }).format(value);
export const recentDate = (timestamp: number): string =>
  timestamp > 0
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
        timestamp
      )
    : "Unknown";
export const chartDate = (date: string): string =>
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
export const aggregateChartData = (
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
export const allTimeChartGranularity = allTimeGranularity;
export const chartPeriodLabel = (
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
export const chartHourLabel = chartHour;
export const matchesQuery = (values: string[], query: string): boolean =>
  values.join(" ").toLowerCase().includes(query.trim().toLowerCase());

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];
const relativeFormatter = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
});
export const relativeTime = (timestamp: number, now = Date.now()): string => {
  if (timestamp <= 0) {
    return "Unknown";
  }
  const elapsed = timestamp - now;
  for (const [unit, milliseconds] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= milliseconds) {
      return relativeFormatter.format(Math.round(elapsed / milliseconds), unit);
    }
  }
  return "just now";
};

/** Sums tokens and cost per distinct value of `key`, largest first. */
export const groupUsage = <T extends { cost: number; tokens: number }>(
  items: readonly T[],
  key: (item: T) => string
): { cost: number; name: string; tokens: number }[] => {
  const groups = new Map<
    string,
    { cost: number; name: string; tokens: number }
  >();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name) ?? { cost: 0, name, tokens: 0 };
    group.cost += item.cost;
    group.tokens += item.tokens;
    groups.set(name, group);
  }
  return [...groups.values()].toSorted(
    (left, right) => right.tokens - left.tokens
  );
};
