import {
  getCacheHitRatio,
  type AnalyticsDashboardResponse,
} from "@open-inspect/shared/types/analytics";
import {
  ANALYTICS_SCOPE_CAPTIONS,
  ANALYTICS_UNKNOWN_USER_KEY,
  formatAnalyticsCompactCount,
  formatAnalyticsCost,
  formatAnalyticsCount,
  formatAnalyticsLongDuration,
  formatAnalyticsRatio,
  getCompletionRate,
  getCostPerMergedPullRequest,
  getDailyPullRequestCounts,
  getDailySessionCounts,
  getPullRequestAcceptanceRate,
  getSubscriptionShare,
} from "@/lib/analytics";
import type { AnalyticsKpiGroup, AnalyticsKpiItem } from "./analytics-kpis";

/** The overview's headline numbers, split by what the scope filter applies to. */
export function getHeadlineKpiGroups(dashboard: AnalyticsDashboardResponse): AnalyticsKpiGroup[] {
  const { summary, pullRequests, window } = dashboard;
  const status = summary.statusBreakdown;
  const completion = getCompletionRate(status);
  // Divide attributed sessions by the people they belong to; unattributed sessions
  // have no person, so counting them would inflate everyone's share.
  const people = dashboard.breakdowns.user.entries.filter(
    (entry) => entry.key !== ANALYTICS_UNKNOWN_USER_KEY
  );
  const attributedSessions = people.reduce((sum, entry) => sum + entry.sessions, 0);

  return [
    {
      caption: ANALYTICS_SCOPE_CAPTIONS[window.scope],
      items: [
        {
          label: "Sessions",
          value: formatAnalyticsCount(summary.totalSessions),
          detail: `About ${formatAnalyticsCount(Math.round(summary.totalSessions / window.days))} a day`,
          trend: getDailySessionCounts(dashboard).map((point) => point.sessions),
        },
        {
          label: "Active users",
          value: formatAnalyticsCount(summary.activeUsers),
          detail:
            people.length > 0
              ? `${formatAnalyticsCount(Math.round(attributedSessions / people.length))} sessions per person`
              : "No attributed users",
        },
        {
          label: "Spend",
          value: formatAnalyticsCost(summary.totalCost),
          detail: `${formatAnalyticsCost(summary.avgCost)} per session`,
        },
        {
          label: "Completion rate",
          value: formatAnalyticsRatio(completion),
          detail: `${formatAnalyticsCount(status.failed)} failed · ${formatAnalyticsCount(status.cancelled)} cancelled`,
          ratio: completion,
        },
      ],
    },
    {
      caption: "Pull requests · every source",
      items: [
        {
          // Merges during the window: the same population as the daily-merges
          // sparkline and the average time to merge.
          label: "PRs merged",
          value: formatAnalyticsCount(pullRequests.mergedInWindow),
          detail:
            pullRequests.avgTimeToMergeMs === null
              ? "None merged in range"
              : `Avg ${formatAnalyticsLongDuration(pullRequests.avgTimeToMergeMs)} to merge`,
          trend: getDailyPullRequestCounts(dashboard).map((point) => point.merged),
        },
        {
          label: "Cost per merged PR",
          value: formatAnalyticsCost(
            getCostPerMergedPullRequest(pullRequests.prSessionCost, pullRequests.funnel.merged)
          ),
          detail: "PRs opened in range",
        },
      ],
    },
  ];
}

export function getCostKpis(dashboard: AnalyticsDashboardResponse): AnalyticsKpiItem[] {
  const { summary } = dashboard;
  const cacheHitRatio = getCacheHitRatio(summary);
  const items: AnalyticsKpiItem[] = [
    {
      label: "Spend",
      value: formatAnalyticsCost(summary.totalCost),
      detail: `${formatAnalyticsCost(summary.avgCost)} per session`,
    },
    {
      label: "Cache hit ratio",
      value: formatAnalyticsRatio(cacheHitRatio),
      detail: "Of input read from cache",
      ratio: cacheHitRatio,
    },
    {
      label: "Billed to subscriptions",
      value: formatAnalyticsRatio(getSubscriptionShare(dashboard.breakdowns.provider.entries)),
      detail: "Of sessions; they report $0",
    },
    {
      label: "Tokens",
      value: formatAnalyticsCompactCount(summary.inputTokens + summary.outputTokens),
      detail: `${formatAnalyticsCompactCount(summary.inputTokens)} in · ${formatAnalyticsCompactCount(summary.outputTokens)} out`,
    },
  ];
  // Only owners and administrators receive private-session cost.
  if (summary.privateSessionsCostUsd !== null) {
    items.push({
      label: "Private sessions",
      value: formatAnalyticsCost(summary.privateSessionsCostUsd),
      detail: "Not included in spend",
    });
  }
  return items;
}

export function getPullRequestKpis(dashboard: AnalyticsDashboardResponse): AnalyticsKpiItem[] {
  const { funnel, openInventory, avgTimeToMergeMs, mergedInWindow, prSessionCost } =
    dashboard.pullRequests;
  return [
    {
      label: "Opened",
      value: formatAnalyticsCount(funnel.created),
      detail: `In the last ${dashboard.window.days} days`,
    },
    {
      label: "Acceptance rate",
      value: formatAnalyticsRatio(getPullRequestAcceptanceRate(funnel)),
      detail: `${formatAnalyticsCount(funnel.merged)} merged · ${formatAnalyticsCount(funnel.closed)} closed unmerged`,
    },
    {
      label: "Avg time to merge",
      value: avgTimeToMergeMs === null ? "—" : formatAnalyticsLongDuration(avgTimeToMergeMs),
      detail: `${formatAnalyticsCount(mergedInWindow)} merged in range`,
    },
    {
      label: "Open now",
      value: formatAnalyticsCount(openInventory.total),
      detail:
        openInventory.avgAgeMs === null
          ? "Nothing waiting on review"
          : `Avg age ${formatAnalyticsLongDuration(openInventory.avgAgeMs)}`,
    },
    {
      label: "Cost per merged PR",
      value: formatAnalyticsCost(getCostPerMergedPullRequest(prSessionCost, funnel.merged)),
      detail: `${formatAnalyticsCost(prSessionCost)} across PR sessions`,
    },
  ];
}
