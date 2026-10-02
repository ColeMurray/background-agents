import type { AnalyticsPullRequestDimensionEntry } from "@open-inspect/shared/types/analytics";
import {
  formatAnalyticsCount,
  getAnalyticsDimensionLabels,
  getCostPerMergedPullRequest,
} from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

interface PullRequestCostTableProps {
  title: string;
  entries?: AnalyticsPullRequestDimensionEntry[];
  loading: boolean;
}

export function AnalyticsPullRequestCostTable({
  title,
  entries,
  loading,
}: PullRequestCostTableProps) {
  if (loading && !entries) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-36 rounded bg-muted" />
        <div className="mt-2 h-4 w-64 rounded bg-muted" />
        <div className="mt-6 h-56 rounded bg-muted" />
      </div>
    );
  }

  if (!entries?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground">
          No pull request cost data found for this range.
        </p>
      </div>
    );
  }

  const labels = getAnalyticsDimensionLabels(entries);

  return (
    <div className="rounded-md border border-border-muted bg-card">
      <div className="border-b border-border-muted px-5 py-4">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Cost of PR-producing sessions.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-muted text-left text-secondary-foreground">
              <th scope="col" className="px-5 py-3">
                Key
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Created
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Merged
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Cost per merged PR
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const cost = getCostPerMergedPullRequest(entry.sessionCost, entry.merged);
              return (
                <tr
                  key={entry.key}
                  className="border-b border-border-muted last:border-b-0 hover:bg-muted/50"
                >
                  <td className="px-5 py-4 font-medium text-foreground">
                    {labels.get(entry.key) ?? entry.key}
                  </td>
                  <td className="px-5 py-4 text-right text-foreground">
                    {formatAnalyticsCount(entry.created)}
                  </td>
                  <td className="px-5 py-4 text-right text-foreground">
                    {formatAnalyticsCount(entry.merged)}
                  </td>
                  <td className="px-5 py-4 text-right text-foreground">
                    {cost === null ? "—" : formatSessionCost(cost)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
