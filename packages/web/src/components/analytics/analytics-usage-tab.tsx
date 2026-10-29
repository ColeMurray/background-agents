"use client";

import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import { getDailySessionCounts } from "@/lib/analytics";
import { AnalyticsCostTable } from "./cost-table";
import { AnalyticsPanel } from "./analytics-panel";
import { AnalyticsTrendChart, SESSION_TREND_SERIES } from "./analytics-trend-chart";
import { AnalyticsRepositoryTable, getRepositoryOwnerNote } from "./repository-table";
import { AnalyticsAttributionNote, AnalyticsSessionSources } from "./session-sources";
import { AnalyticsSessionStatusSummary } from "./session-status-summary";

/** How much the platform is used, where sessions start, and how they end. */
export function AnalyticsUsageTab({
  dashboard,
  filterKey,
}: {
  dashboard: AnalyticsDashboardResponse;
  /** Changes with the range and scope, resetting the source selection. */
  filterKey: string;
}) {
  const repositories = dashboard.breakdowns.repository.entries;
  const showAutomations =
    dashboard.window.scope === "automation" || dashboard.window.scope === "all";
  return (
    <div className="space-y-4">
      <AnalyticsPanel title="Sessions per day">
        <AnalyticsTrendChart
          data={getDailySessionCounts(dashboard)}
          series={SESSION_TREND_SERIES}
          height={280}
          emptyMessage="No sessions found for this range."
        />
      </AnalyticsPanel>
      <div className="grid gap-4 lg:grid-cols-3">
        <AnalyticsPanel
          title="Where sessions start"
          description="Select a source to see who its sessions are attributed to"
          className="lg:col-span-2"
          footer={<AnalyticsAttributionNote />}
        >
          <AnalyticsSessionSources key={filterKey} entries={dashboard.sessionOrigins} />
        </AnalyticsPanel>
        <AnalyticsPanel title="How sessions ended">
          <AnalyticsSessionStatusSummary status={dashboard.summary.statusBreakdown} />
        </AnalyticsPanel>
      </div>
      <AnalyticsPanel
        title="Repositories"
        description={getRepositoryOwnerNote(repositories)}
        bodyClassName="pt-2"
      >
        <AnalyticsRepositoryTable entries={repositories} limit={10} />
      </AnalyticsPanel>
      {showAutomations ? (
        <AnalyticsPanel
          title="Automations"
          description="Sessions, completion and cost by automation"
          bodyClassName="pt-2"
        >
          <AnalyticsCostTable dashboard={dashboard} dimension="automation" />
        </AnalyticsPanel>
      ) : null}
    </div>
  );
}
