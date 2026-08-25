import type {
  DashboardSummary,
  SessionSummary,
  TimeRange,
} from "@toktracker/shared";
import { z } from "zod";

const finiteNonNegative = z.number().finite().nonnegative();
const tokenBreakdownSchema = z.object({
  cacheRead: finiteNonNegative,
  cacheWrite: finiteNonNegative,
  input: finiteNonNegative,
  output: finiteNonNegative,
  reasoning: finiteNonNegative,
});
const timeSeriesPointSchema = z.object({
  cost: finiteNonNegative,
  date: z.string(),
  tokens: finiteNonNegative,
});
const usageEntrySchema = z.object({
  cost: finiteNonNegative,
  name: z.string(),
  tokens: finiteNonNegative,
});
const projectEntrySchema = usageEntrySchema.extend({
  lastSeen: z.number().finite(),
  sessions: finiteNonNegative,
});
const usageDetailSchema = z.object({
  agents: z.array(usageEntrySchema),
  daily: z.array(timeSeriesPointSchema),
  models: z.array(usageEntrySchema),
  projects: z.array(projectEntrySchema),
});
const sessionPartSchema = z.object({
  cost: finiteNonNegative,
  lastSeen: z.number().finite(),
  messages: finiteNonNegative,
  model: z.string(),
  provider: z.string(),
  startedAt: z.number().finite(),
  tokens: tokenBreakdownSchema,
});
export const sessionSummarySchema: z.ZodType<SessionSummary> = z.object({
  client: z.string(),
  cost: finiteNonNegative,
  createdAt: z.number().finite(),
  deviceId: z.string(),
  id: z.string(),
  lastSeen: z.number().finite(),
  model: z.string(),
  parts: z.array(sessionPartSchema).optional(),
  project: z.string(),
  sessionId: z.string(),
  sourcePath: z.string(),
  title: z.string().optional(),
  tokens: finiteNonNegative,
});
export const dashboardSummarySchema: z.ZodType<DashboardSummary> = z.object({
  agentDetails: z.record(z.string(), usageDetailSchema),
  agents: z.array(usageEntrySchema),
  daily: z.array(timeSeriesPointSchema),
  devices: z.array(
    z.object({
      id: z.string(),
      lastSeen: z.number().finite(),
      name: z.string(),
      platform: z.string(),
    })
  ),
  hourly: z.array(timeSeriesPointSchema),
  modelDetails: z.record(z.string(), usageDetailSchema).optional(),
  models: z.array(usageEntrySchema),
  projectDetails: z.record(z.string(), usageDetailSchema),
  projects: z.array(projectEntrySchema),
  recentSessions: z.array(sessionSummarySchema),
  totals: z.object({
    cost: finiteNonNegative,
    estimatedCost: finiteNonNegative,
    messages: finiteNonNegative,
    reportedCost: finiteNonNegative,
    sessions: finiteNonNegative,
    tokens: finiteNonNegative,
    unpricedTokens: finiteNonNegative,
  }),
});

export const sessionSummaryListSchema = z.array(sessionSummarySchema);
export const timeRangeSchema: z.ZodType<TimeRange> = z.enum([
  "day",
  "week",
  "month",
  "year",
  "all",
]);
export const chartMetricSchema = z.enum(["tokens", "cost"]);
export const dashboardDeviceListSchema = z.array(
  z.object({
    createdAt: z.number().finite(),
    id: z.string(),
    lastSeen: z.number().finite(),
    name: z.string(),
  })
);
export const clientAutoUpdateSettingsSchema = z.object({
  channel: z.enum(["nightly", "stable"]),
  enabled: z.boolean(),
  windowEndHour: z.number().int().min(0).max(23),
  windowStartHour: z.number().int().min(0).max(23),
});
export const cursorAccountStatusSchema = z.object({
  cloudAgentApiKeyConfigured: z.boolean().optional(),
  id: z.string(),
  isActive: z.boolean(),
  label: z.string().optional(),
});
const cursorDeviceOverviewSchema = z.object({
  accounts: z.array(cursorAccountStatusSchema),
  desktopEmail: z.string().optional(),
  desktopSignedIn: z.boolean(),
  deviceId: z.string(),
  lastError: z.string().optional(),
  lastSyncAt: z.number().finite().optional(),
  name: z.string().optional(),
  syncIntervalMs: z.number().finite(),
  updatedAt: z.number().finite(),
});
const cursorSettingsSchema = z.object({
  cloudAgentApiKey: z.string().optional(),
  enabled: z.boolean(),
  includeAutomations: z.boolean().optional().default(false),
  includeCloudAgents: z.boolean().optional().default(false),
  syncIntervalMs: z.number().finite(),
  t3Home: z.string().optional(),
  useT3CodeLocalSessions: z.boolean().optional().default(true),
});
export const cloudAgentAccountOverviewSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export const cursorDashboardOverviewSchema = cursorSettingsSchema.extend({
  cloudAgentAccounts: z.array(cloudAgentAccountOverviewSchema).default([]),
  devices: z.array(cursorDeviceOverviewSchema),
});
export const providerDashboardOverviewSchema = z.object({
  cloudAgentAccounts: z.array(cloudAgentAccountOverviewSchema).default([]),
  copilot: z.object({
    enabled: z.boolean(),
    importDesktop: z.boolean(),
    importOtel: z.boolean(),
    importVsCode: z.boolean(),
    otelExporterFile: z.string().optional(),
  }),
  cursor: cursorSettingsSchema,
  devices: z.array(cursorDeviceOverviewSchema),
});
export const errorResponseSchema = z.object({ error: z.string() });
