"use client";

import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import { AnalyticsPanel } from "./analytics-panel";
import { AnalyticsPeopleTable } from "./people-table";
import { AnalyticsAttributionNote, AnalyticsSessionSources } from "./session-sources";

/** Usage per person, sortable, without ranking or gamification. */
export function AnalyticsPeopleTab({
  dashboard,
  filterKey,
}: {
  dashboard: AnalyticsDashboardResponse;
  /** Changes with the range and scope, resetting the source selection. */
  filterKey: string;
}) {
  return (
    <div className="space-y-4">
      <AnalyticsPanel bodyClassName="pt-1">
        <AnalyticsPeopleTable dashboard={dashboard} />
      </AnalyticsPanel>
      <AnalyticsPanel
        title="People by source"
        description="Select a source to see who its sessions are attributed to"
        footer={<AnalyticsAttributionNote />}
      >
        <AnalyticsSessionSources key={filterKey} entries={dashboard.sessionOrigins} />
      </AnalyticsPanel>
    </div>
  );
}
