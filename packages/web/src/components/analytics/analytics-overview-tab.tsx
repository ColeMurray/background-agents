"use client";

import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import { ChevronRightIcon } from "@/components/ui/icons";
import {
  ANALYTICS_TAB_LABELS,
  formatAnalyticsCost,
  formatAnalyticsCount,
  formatAnalyticsRatio,
  formatRepositoryName,
  getAnalyticsDimensionLabels,
  getCommonRepositoryOwner,
  getCompletionRate,
  getDailyPullRequestCounts,
  getDailySessionCounts,
  getFinishedSessionCount,
  type AnalyticsTab,
} from "@/lib/analytics";
import { getHeadlineKpiGroups } from "./analytics-kpi-items";
import { AnalyticsKpiGroups } from "./analytics-kpis";
import { AnalyticsPanel } from "./analytics-panel";
import { AnalyticsRankedBars } from "./analytics-ranked-bars";
import {
  AnalyticsLegendKey,
  AnalyticsTrendChart,
  PULL_REQUEST_TREND_SERIES,
  SESSION_TREND_SERIES,
} from "./analytics-trend-chart";

const TOP_COUNT = 5;

/** The common questions on one screen, each linking to the tab with the detail. */
export function AnalyticsOverviewTab({
  dashboard,
  onSelectTab,
}: {
  dashboard: AnalyticsDashboardResponse;
  onSelectTab: (tab: AnalyticsTab) => void;
}) {
  const repositories = dashboard.breakdowns.repository.entries;
  const owner = getCommonRepositoryOwner(repositories.map((entry) => entry.key));
  const models = dashboard.breakdowns.model.entries;
  const modelLabels = getAnalyticsDimensionLabels(models);

  function tabLink(tab: AnalyticsTab) {
    return (
      <button
        type="button"
        onClick={() => onSelectTab(tab)}
        className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {ANALYTICS_TAB_LABELS[tab]}
        <ChevronRightIcon className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="space-y-6">
      <AnalyticsKpiGroups groups={getHeadlineKpiGroups(dashboard)} />

      <div className="grid gap-4 xl:grid-cols-2">
        <AnalyticsPanel title="Sessions per day" actions={tabLink("usage")}>
          <AnalyticsTrendChart
            data={getDailySessionCounts(dashboard)}
            series={SESSION_TREND_SERIES}
            height={200}
            emptyMessage="No sessions found for this range."
          />
        </AnalyticsPanel>
        <AnalyticsPanel
          title="Pull requests opened and merged"
          actions={
            <>
              {PULL_REQUEST_TREND_SERIES.map((series) => (
                <AnalyticsLegendKey key={series.key} color={series.color} label={series.label} />
              ))}
              {tabLink("pull-requests")}
            </>
          }
        >
          <AnalyticsTrendChart
            data={getDailyPullRequestCounts(dashboard)}
            series={PULL_REQUEST_TREND_SERIES}
            height={200}
            emptyMessage="No pull requests found for this range."
          />
        </AnalyticsPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <AnalyticsPanel
          title="Top repositories"
          description="By sessions, with cost"
          actions={tabLink("usage")}
        >
          <AnalyticsRankedBars
            label="Top repositories by sessions"
            rows={repositories.slice(0, TOP_COUNT).map((entry) => ({
              key: entry.key,
              label: formatRepositoryName(entry.key, owner),
              value: entry.sessions,
              display: formatAnalyticsCount(entry.sessions),
              secondary: formatAnalyticsCost(entry.cost),
            }))}
            emptyMessage="No repository data found for this range."
          />
        </AnalyticsPanel>
        <AnalyticsPanel
          title="Spend by model"
          description="With cost per session"
          actions={tabLink("cost")}
        >
          <AnalyticsRankedBars
            label="Spend by model"
            rows={[...models]
              .sort((a, b) => b.cost - a.cost)
              .slice(0, TOP_COUNT)
              .map((entry) => ({
                key: entry.key,
                label: modelLabels.get(entry.key) ?? entry.key,
                value: entry.cost,
                display: formatAnalyticsCost(entry.cost),
                secondary: formatAnalyticsCost(
                  entry.sessions > 0 ? entry.cost / entry.sessions : 0
                ),
              }))}
            emptyMessage="No model data found for this range."
          />
        </AnalyticsPanel>
        <AnalyticsPanel
          title="Most active people"
          description="By sessions, with completion rate"
          actions={tabLink("people")}
        >
          <AnalyticsRankedBars
            label="Most active people"
            rows={dashboard.breakdowns.user.entries.slice(0, TOP_COUNT).map((entry) => ({
              key: entry.key,
              label: entry.displayName ?? entry.key,
              value: entry.sessions,
              display: formatAnalyticsCount(entry.sessions),
              secondary: formatAnalyticsRatio(
                getFinishedSessionCount(entry) > 0 ? getCompletionRate(entry) : null
              ),
            }))}
            emptyMessage="No user analytics found for this range."
          />
        </AnalyticsPanel>
      </div>
    </div>
  );
}
