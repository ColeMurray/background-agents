import Link from "next/link";
import type { SessionRun } from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";
import { formatRelativeTime } from "@/lib/time";

interface RunsTableProps {
  runs?: SessionRun[];
  loading: boolean;
}

export function AnalyticsRunsTable({ runs, loading }: RunsTableProps) {
  if (loading && !runs) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-36 rounded bg-muted" />
        <div className="mt-2 h-4 w-64 rounded bg-muted" />
        <div className="mt-6 h-56 rounded bg-muted" />
      </div>
    );
  }

  const description =
    "Scope and time range select roots; totals include all descendants, even outside the selected scope or range.";

  if (!runs?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Top Runs by Cost</div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <p className="mt-1 text-sm text-muted-foreground">No runs found for this range.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-muted bg-card">
      <div className="border-b border-border-muted px-5 py-4">
        <h2 className="text-lg font-semibold text-foreground">Top Runs by Cost</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-muted text-left text-secondary-foreground">
              <th scope="col" className="px-5 py-3">
                Title
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Sessions
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Depth
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Cost
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                PRs
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Input + output tokens
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Started
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.rootSessionId}
                className="border-b border-border-muted last:border-b-0 hover:bg-muted/50"
              >
                <td className="max-w-xs px-5 py-4 font-medium text-foreground">
                  <Link
                    href={`/session/${run.rootSessionId}`}
                    className="block truncate hover:underline"
                  >
                    {run.title ?? "Untitled session"}
                  </Link>
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(run.sessionCount)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(run.maxSpawnDepth)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatSessionCost(run.totalCost)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(run.totalPrs)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(run.inputTokens + run.outputTokens)}
                </td>
                <td className="px-5 py-4 text-right text-muted-foreground">
                  {formatRelativeTime(run.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
