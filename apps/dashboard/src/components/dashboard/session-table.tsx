import type { DashboardSummary } from "@toktracker/shared";

import { compact, money } from "@/lib/dashboard";
import { Link } from "@/lib/navigation";

import { AgentLogo, Card } from "./primitives";

export const SessionTable = ({
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
                  {session.title ?? session.sessionId}
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
