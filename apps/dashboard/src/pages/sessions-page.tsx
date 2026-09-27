import type {
  DashboardSummary,
  SessionSort,
  SessionSummary,
} from "@toktracker/shared";
import { Bot, CircleDollarSign, Cpu, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { CustomizableView } from "@/components/dashboard/customizable-view";
import { AgentFilter } from "@/components/dashboard/filters";
import { PageHeading } from "@/components/dashboard/page-heading";
import { EmptyState, Stat } from "@/components/dashboard/primitives";
import { SessionTable } from "@/components/dashboard/session-table";
import { apiFetch } from "@/lib/api";
import { compact, groupUsage, matchesQuery, money } from "@/lib/dashboard";
import { sessionSummaryListSchema, sessionSummarySchema } from "@/lib/schemas";

export const SessionsPage = ({
  data,
  deviceParam,
  query,
  sessionSort,
}: {
  data: DashboardSummary;
  deviceParam: string;
  query: string;
  sessionSort: SessionSort;
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
        const params = new URLSearchParams({ limit: "200", sort: sessionSort });
        if (deviceParam) {
          params.set("devices", deviceParam);
        }
        if (agentParam) {
          params.set("agents", agentParam);
        }
        const response = await apiFetch(`/api/v1/sessions/search?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Sessions request failed");
        }
        setAllSessions(sessionSummaryListSchema.parse(await response.json()));
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
  }, [agentParam, deviceParam, sessionSort]);

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
        session.sessionId,
        session.project,
        session.model,
        session.client,
      ],
      query
    )
  );

  return (
    <CustomizableView
      view="sessions"
      data={{
        breakdowns: {
          agent: groupUsage(sessions, (session) => session.client),
          model: groupUsage(sessions, (session) => session.model),
          project: groupUsage(sessions, (session) => session.project),
        },
        periodLabel: `${sessions.length} loaded sessions`,
        query: { sessions: allSessions },
        slots: {
          "sessions-table": loading ? (
            <EmptyState>Loading sessions…</EmptyState>
          ) : (
            <SessionTable
              sessions={sessions}
              showViewAll={false}
              title="All sessions"
            />
          ),
        },
      }}
      actions={
        <AgentFilter
          agents={data.agents}
          selectedNames={selectedAgentNames}
          setSelectedNames={setSelectedAgentNames}
        />
      }
      heading={
        <PageHeading
          title="Sessions"
          description="All coding sessions across every selected device."
        />
      }
    />
  );
};

export const SessionPage = ({
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
    const controller = new AbortController();
    const loadSession = async (): Promise<void> => {
      try {
        const params = new URLSearchParams();
        if (deviceParam) {
          params.set("devices", deviceParam);
        }
        const response = await apiFetch(
          `/api/v1/sessions/${encodeURIComponent(id)}?${params}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error("Session request failed");
        }
        setLoadedSession({
          id,
          session: sessionSummarySchema.parse(await response.json()),
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
    (loadedSession.id === id ? loadedSession.session : undefined) ??
    recentSession;
  if (!recentSession && loadedSession.id !== id) {
    return <EmptyState>Loading session…</EmptyState>;
  }
  if (!session) {
    return <EmptyState>Session not found.</EmptyState>;
  }
  const partUsage = (session.parts ?? []).map((part) => ({
    cost: part.cost,
    model: part.model,
    tokens:
      part.tokens.input +
      part.tokens.output +
      part.tokens.cacheRead +
      part.tokens.cacheWrite +
      part.tokens.reasoning,
  }));
  return (
    <CustomizableView
      view="session"
      data={{
        breakdowns: session.parts
          ? { model: groupUsage(partUsage, (part) => part.model) }
          : {},
        periodLabel: "This session",
        slots: session.parts
          ? {
              "session-parts": (
                <section className="surface-card overflow-x-auto p-5">
                  <h2 className="mb-4 font-semibold">Model usage</h2>
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="pb-3 font-medium">Model</th>
                        <th className="pb-3 pl-6 font-medium">Tokens</th>
                        <th className="pb-3 pl-6 font-medium">Messages</th>
                        <th className="pb-3 pl-6 text-right font-medium">
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {session.parts.map((part) => (
                        <tr
                          key={`${part.startedAt}-${part.model}-${part.provider}`}
                          className="border-b last:border-0"
                        >
                          <td className="py-3">{part.model}</td>
                          <td className="py-3 pl-6">
                            {compact(
                              part.tokens.input +
                                part.tokens.output +
                                part.tokens.cacheRead +
                                part.tokens.cacheWrite +
                                part.tokens.reasoning
                            )}
                          </td>
                          <td className="py-3 pl-6">{part.messages}</td>
                          <td className="py-3 pl-6 text-right">
                            {money(part.cost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ),
            }
          : {},
        stats: (
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
        ),
      }}
      heading={
        <PageHeading
          title={session.title ?? session.sessionId}
          description={`${session.project} · ${session.sessionId}`}
        />
      }
    />
  );
};
