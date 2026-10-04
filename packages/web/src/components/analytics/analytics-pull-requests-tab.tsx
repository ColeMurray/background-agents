import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import { getDailyPullRequestCounts } from "@/lib/analytics";
import { getPullRequestKpis } from "./analytics-kpi-items";
import { AnalyticsKpiStrip } from "./analytics-kpis";
import { AnalyticsPanel } from "./analytics-panel";
import {
  AnalyticsLegendKey,
  AnalyticsTrendChart,
  PULL_REQUEST_TREND_SERIES,
} from "./analytics-trend-chart";
import { AnalyticsPullRequestCostTable } from "./pull-request-cost-table";
import { AnalyticsPullRequestOutcomes } from "./pull-request-outcomes";
import { AnalyticsPullRequestRepoTable } from "./pull-request-repo-table";
import { AnalyticsPullRequestSources } from "./pull-request-sources";

/**
 * Outcomes of pull requests created through the platform. Rates are over pull
 * requests, not sessions, and every source counts whatever the scope.
 */
export function AnalyticsPullRequestsTab({ dashboard }: { dashboard: AnalyticsDashboardResponse }) {
  const { pullRequests } = dashboard;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pull requests created through the platform, including automation-created ones. Rates are
        computed over pull requests, not sessions, and include every source whatever the scope.
      </p>
      <AnalyticsKpiStrip items={getPullRequestKpis(dashboard)} />
      <div className="grid gap-4 lg:grid-cols-3">
        <AnalyticsPanel
          title="Pull requests over time"
          description="Opened by the day each PR opened; merged by the day it merged"
          className="lg:col-span-2"
          actions={PULL_REQUEST_TREND_SERIES.map((series) => (
            <AnalyticsLegendKey key={series.key} color={series.color} label={series.label} />
          ))}
        >
          <AnalyticsTrendChart
            data={getDailyPullRequestCounts(dashboard)}
            series={PULL_REQUEST_TREND_SERIES}
            height="fill"
            emptyMessage="No pull requests found for this range."
          />
        </AnalyticsPanel>
        <AnalyticsPanel title="Where they stand">
          <AnalyticsPullRequestOutcomes funnel={pullRequests.funnel} />
          <div className="mt-5 border-t border-border-muted pt-4">
            <div className="mb-1 px-2 text-xs text-muted-foreground">By source</div>
            <AnalyticsPullRequestSources entries={pullRequests.sources} />
          </div>
        </AnalyticsPanel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <AnalyticsPanel title="By repository" bodyClassName="pt-2">
          <AnalyticsPullRequestRepoTable entries={pullRequests.repos} />
        </AnalyticsPanel>
        <AnalyticsPanel
          title="Cost per merged PR"
          description="Cost of the sessions that produced the pull requests"
          bodyClassName="pt-3"
        >
          <AnalyticsPullRequestCostTable pullRequests={pullRequests} />
        </AnalyticsPanel>
      </div>
    </div>
  );
}
