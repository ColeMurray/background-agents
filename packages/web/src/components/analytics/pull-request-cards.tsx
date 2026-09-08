import type { AnalyticsDays, AnalyticsPullRequestsResponse } from "@open-inspect/shared";
import { SummaryCard } from "@/components/analytics/summary-cards";
import {
  formatAnalyticsCount,
  formatAnalyticsLongDuration,
  formatPullRequestAcceptanceRate,
  getCostPerMergedPullRequest,
} from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

interface PullRequestCardsProps {
  days: AnalyticsDays;
  pullRequests?: AnalyticsPullRequestsResponse;
  loading: boolean;
}

export function AnalyticsPullRequestCards({ days, pullRequests, loading }: PullRequestCardsProps) {
  if (loading && !pullRequests) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="rounded-md border border-border-muted bg-card p-4 animate-pulse"
          >
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="mt-4 h-7 w-20 rounded bg-muted" />
            <div className="mt-3 h-4 w-32 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (!pullRequests) return null;

  const { funnel, openInventory } = pullRequests;
  const costPerMerged = getCostPerMergedPullRequest(pullRequests);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          label="PRs Created"
          value={formatAnalyticsCount(funnel.created)}
          hint={`Opened in the last ${days} days`}
        />
        <SummaryCard
          label="Acceptance Rate"
          value={formatPullRequestAcceptanceRate(funnel)}
          hint={`${formatAnalyticsCount(funnel.merged)} merged · ${formatAnalyticsCount(funnel.closed)} closed unmerged`}
        />
        <SummaryCard
          label="Avg Time to Merge"
          value={
            pullRequests.avgTimeToMergeMs !== null
              ? formatAnalyticsLongDuration(pullRequests.avgTimeToMergeMs)
              : "—"
          }
          hint={`${formatAnalyticsCount(pullRequests.mergedInWindow)} merged in range`}
        />
        <SummaryCard
          label="Open PRs"
          value={formatAnalyticsCount(openInventory.total)}
          hint={
            openInventory.avgAgeMs !== null
              ? `Avg age ${formatAnalyticsLongDuration(openInventory.avgAgeMs)}`
              : "Nothing waiting on review"
          }
        />
        <SummaryCard
          label="Cost / Merged PR"
          value={costPerMerged !== null ? formatSessionCost(costPerMerged) : "—"}
          hint="Cost of PR-producing sessions"
        />
      </div>

      {pullRequests.sources.length > 0 ? (
        <div className="rounded-md border border-border-muted bg-card px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-secondary-foreground">
            By Source
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Where the sessions behind these pull requests came from.
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            {pullRequests.sources.map((entry) => (
              <div
                key={entry.source}
                className="rounded-md border border-border-muted bg-background px-3 py-3"
              >
                <div className="text-xs uppercase tracking-wider text-secondary-foreground">
                  {entry.source}
                </div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {formatAnalyticsCount(entry.created)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatAnalyticsCount(entry.merged)} merged
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
