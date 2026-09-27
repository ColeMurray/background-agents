import type {
  AnalyticsDashboardResponse,
  AnalyticsDays,
  AnalyticsScope,
} from "@open-inspect/shared/types/analytics";
import { AnalyticsStore } from "./analytics-store";
import { PullRequestAnalyticsStore } from "./pull-request-analytics-store";
import { SessionRunStore } from "./session-run-store";
import type { SqlDatabase } from "./sql-database";

export interface AnalyticsDashboardFilters {
  days: AnalyticsDays;
  scope: AnalyticsScope;
  startAt: number;
  endAt: number;
}

export const DASHBOARD_RUNS_LIMIT = 20;

export class AnalyticsDashboardStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(filters: AnalyticsDashboardFilters): Promise<AnalyticsDashboardResponse> {
    const analytics = new AnalyticsStore(this.db);
    const pullRequests = new PullRequestAnalyticsStore(this.db);
    const runs = new SessionRunStore(this.db);
    const sessionFilters = {
      startAt: filters.startAt,
      endAt: filters.endAt,
      scope: filters.scope,
    };
    const pullRequestStatements = pullRequests.prepare({
      startAt: filters.startAt,
      endAt: filters.endAt,
      now: filters.endAt,
    });
    const [modelStatement, billingStatement] = analytics.prepareProviderBreakdown(sessionFilters);

    const [
      summary,
      timeseries,
      repository,
      user,
      model,
      harness,
      automation,
      billing,
      ...pullRequestAndRunResults
    ] = await this.db.batch([
      analytics.prepareSummary(sessionFilters),
      analytics.prepareTimeseries(sessionFilters),
      analytics.prepareBreakdown(sessionFilters, "repo"),
      analytics.prepareBreakdown(sessionFilters, "user"),
      modelStatement,
      analytics.prepareBreakdown(sessionFilters, "harness"),
      analytics.prepareBreakdown(sessionFilters, "automation"),
      billingStatement,
      ...pullRequestStatements,
      runs.prepareList({ ...sessionFilters, limit: DASHBOARD_RUNS_LIMIT, orderBy: "cost" }),
    ]);
    const runResult = pullRequestAndRunResults.pop();
    if (!runResult) throw new Error("Missing dashboard runs result");
    const modelBreakdown = analytics.decodeBreakdown(model, "model");

    return {
      generatedAt: filters.endAt,
      window: {
        days: filters.days,
        scope: filters.scope,
        startAt: filters.startAt,
        endAt: filters.endAt,
      },
      summary: analytics.decodeSummary(summary),
      timeseries: analytics.decodeTimeseries(timeseries),
      breakdowns: {
        repository: analytics.decodeBreakdown(repository, "repo"),
        user: analytics.decodeBreakdown(user, "user"),
        model: modelBreakdown,
        harness: analytics.decodeBreakdown(harness, "harness"),
        automation: analytics.decodeBreakdown(automation, "automation"),
        provider: analytics.decodeProviderBreakdown(modelBreakdown, billing),
      },
      pullRequests: pullRequests.decode(pullRequestAndRunResults),
      runs: runs.decodeList(runResult),
    };
  }
}
