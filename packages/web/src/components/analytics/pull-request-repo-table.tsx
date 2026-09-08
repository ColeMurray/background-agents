import type { AnalyticsPullRequestRepoEntry } from "@open-inspect/shared";
import {
  formatAnalyticsCount,
  formatAnalyticsLongDuration,
  formatPullRequestAcceptanceRate,
} from "@/lib/analytics";

interface PullRequestRepoTableProps {
  entries?: AnalyticsPullRequestRepoEntry[];
  loading: boolean;
}

export function AnalyticsPullRequestRepoTable({ entries, loading }: PullRequestRepoTableProps) {
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
        <div className="text-lg font-semibold text-foreground">PRs by Repository</div>
        <p className="mt-1 text-sm text-muted-foreground">No pull requests found for this range.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-muted bg-card">
      <div className="border-b border-border-muted px-5 py-4">
        <h2 className="text-lg font-semibold text-foreground">PRs by Repository</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Outcomes for pull requests opened in the selected window.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-card">
            <tr className="border-b border-border-muted text-left text-secondary-foreground">
              <th className="px-5 py-3 font-medium">Repository</th>
              <th className="px-5 py-3 text-right font-medium">Created</th>
              <th className="px-5 py-3 text-right font-medium">Merged</th>
              <th className="px-5 py-3 text-right font-medium">Closed</th>
              <th className="px-5 py-3 text-right font-medium">Acceptance</th>
              <th className="px-5 py-3 text-right font-medium">Avg Time to Merge</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.key}
                className="border-b border-border-muted last:border-b-0 hover:bg-muted/50"
              >
                <td className="px-5 py-4 font-medium text-foreground">{entry.key}</td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(entry.created)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(entry.merged)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(entry.closed)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatPullRequestAcceptanceRate(entry)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {entry.avgTimeToMergeMs !== null
                    ? formatAnalyticsLongDuration(entry.avgTimeToMergeMs)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
