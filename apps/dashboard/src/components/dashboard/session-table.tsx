import type { DashboardSummary } from "@toktracker/shared";
import { ArrowRight, History } from "lucide-react";

import { compact, money, relativeTime } from "@/lib/dashboard";
import { Link } from "@/lib/navigation";

import { AgentLogo, Card, CardHeader, EmptyState } from "./primitives";

export const SessionTable = ({
  sessions,
  showViewAll = true,
  title,
}: {
  sessions: DashboardSummary["recentSessions"];
  showViewAll?: boolean;
  title: string;
}) => (
  <Card className="p-0">
    <div className="p-5 pb-4">
      <CardHeader
        title={title}
        description="Latest tracked activity"
        action={
          showViewAll && (
            <Link
              to="/sessions"
              className="group inline-flex items-center gap-1 text-sm font-medium text-primary"
            >
              View all
              <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
            </Link>
          )
        }
      />
    </div>
    {sessions.length ? (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-y bg-muted/40 text-2xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 font-medium">Project / session</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">
                Agent
              </th>
              <th className="hidden whitespace-nowrap px-3 py-2.5 font-medium md:table-cell">
                Model
              </th>
              <th className="hidden whitespace-nowrap px-3 py-2.5 font-medium sm:table-cell">
                Last active
              </th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">
                Tokens
              </th>
              <th className="whitespace-nowrap px-5 py-2.5 text-right font-medium">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={session.id}
                className="group border-b transition-colors last:border-0 hover:bg-muted/40"
              >
                <td className="max-w-80 px-5 py-3">
                  <Link
                    to={`/sessions/${encodeURIComponent(session.id)}`}
                    className="block truncate font-medium group-hover:text-primary"
                  >
                    {session.title ?? session.sessionId}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {session.project}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                  <span className="flex items-center gap-2 capitalize">
                    <AgentLogo name={session.client} size="size-5" />
                    {session.client}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-3 md:table-cell">
                  <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                    {session.model}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-3 text-muted-foreground sm:table-cell">
                  {relativeTime(session.lastSeen)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">
                  {compact(session.tokens)}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums">
                  {money(session.cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="px-5 pb-5">
        <EmptyState icon={<History />}>No sessions found.</EmptyState>
      </div>
    )}
  </Card>
);
