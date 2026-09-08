import type {
  AnalyticsDashboardResponse,
  AnalyticsDays,
} from "@open-inspect/shared/types/analytics";
import { AnalyticsStore, HUMAN_SPAWN_SOURCES } from "./analytics-store";
import { PullRequestAnalyticsStore } from "./pull-request-analytics-store";
import type { SqlDatabase } from "./sql-database";

export interface AnalyticsDashboardFilters {
  days: AnalyticsDays;
  startAt: number;
  endAt: number;
}

export class AnalyticsDashboardStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(filters: AnalyticsDashboardFilters): Promise<AnalyticsDashboardResponse> {
    const analytics = new AnalyticsStore(this.db);
    const pullRequests = new PullRequestAnalyticsStore(this.db);
    const sessionFilters = {
      startAt: filters.startAt,
      endAt: filters.endAt,
      spawnSources: HUMAN_SPAWN_SOURCES,
    };
    const pullRequestStatements = pullRequests.prepare({
      startAt: filters.startAt,
      endAt: filters.endAt,
      now: filters.endAt,
    });

    const [summary, timeseries, repository, user, ...pullRequestResults] = await this.db.batch([
      analytics.prepareSummary(sessionFilters),
      analytics.prepareTimeseries(sessionFilters),
      analytics.prepareBreakdown(sessionFilters, "repo"),
      analytics.prepareBreakdown(sessionFilters, "user"),
      ...pullRequestStatements,
    ]);

    return {
      generatedAt: filters.endAt,
      window: {
        days: filters.days,
        startAt: filters.startAt,
        endAt: filters.endAt,
      },
      summary: analytics.decodeSummary(summary),
      timeseries: analytics.decodeTimeseries(timeseries),
      breakdowns: {
        repository: analytics.decodeBreakdown(repository),
        user: analytics.decodeBreakdown(user),
      },
      pullRequests: pullRequests.decode(pullRequestResults),
    };
  }
}
