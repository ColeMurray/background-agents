import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import { getCostKpis } from "./analytics-kpi-items";
import { AnalyticsKpiStrip } from "./analytics-kpis";
import { AnalyticsPanel } from "./analytics-panel";
import { AnalyticsCostTable } from "./cost-table";
import { AnalyticsRunsTable } from "./runs-table";
import { AnalyticsTokenTotals } from "./token-totals";

/** What the sessions in scope cost, and where the spend goes. */
export function AnalyticsCostTab({ dashboard }: { dashboard: AnalyticsDashboardResponse }) {
  return (
    <div className="space-y-4">
      <AnalyticsKpiStrip items={getCostKpis(dashboard)} />
      <div className="grid gap-4 xl:grid-cols-2">
        <AnalyticsPanel title="By model" bodyClassName="pt-2">
          <AnalyticsCostTable dashboard={dashboard} dimension="model" />
        </AnalyticsPanel>
        <div className="space-y-4">
          <AnalyticsPanel
            title="By provider"
            description="Sessions billed to a subscription report $0"
            bodyClassName="pt-2"
          >
            <AnalyticsCostTable dashboard={dashboard} dimension="provider" />
          </AnalyticsPanel>
          <AnalyticsPanel title="By harness" bodyClassName="pt-2">
            <AnalyticsCostTable dashboard={dashboard} dimension="harness" />
          </AnalyticsPanel>
        </div>
      </div>
      <AnalyticsPanel
        title="Most expensive runs"
        description="Top 20 runs by cost. A run is a root session plus every sub-session it spawned."
        bodyClassName="pt-2"
      >
        <AnalyticsRunsTable dashboard={dashboard} limit={10} />
      </AnalyticsPanel>
      <AnalyticsPanel
        title="Tokens"
        description="Totals cover sessions created since token capture was enabled; older sessions count as zero."
      >
        <AnalyticsTokenTotals totals={dashboard.summary} />
      </AnalyticsPanel>
    </div>
  );
}
