import type {
  AnalyticsBreakdownBy,
  AnalyticsBreakdownEntry,
  AnalyticsBreakdownResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared";

export interface AnalyticsFilters {
  startAt: number;
  endAt: number;
}

interface SummaryRow {
  total_sessions: number;
  active_users: number;
  total_cost: number;
  total_prs: number;
  created_count: number;
  active_count: number;
  completed_count: number;
  failed_count: number;
  archived_count: number;
  cancelled_count: number;
}

interface TimeseriesRow {
  date: string;
  group_key: string;
  count: number;
}

interface BreakdownRow {
  key: string;
  sessions: number;
  completed: number;
  failed: number;
  cancelled: number;
  cost: number;
  prs: number;
  message_count: number;
  avg_duration: number;
  last_active: number;
}

export class AnalyticsStore {
  constructor(private readonly db: D1Database) {}

  async getSummary(filters: AnalyticsFilters): Promise<AnalyticsSummaryResponse> {
    const result = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_sessions,
           COUNT(DISTINCT CASE WHEN scm_login IS NOT NULL AND scm_login != '' THEN scm_login END) AS active_users,
           COALESCE(SUM(total_cost), 0) AS total_cost,
           COALESCE(SUM(pr_count), 0) AS total_prs,
           COALESCE(SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END), 0) AS created_count,
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_count,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
           COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived_count,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
         FROM sessions
         WHERE created_at >= ? AND created_at < ?`
      )
      .bind(filters.startAt, filters.endAt)
      .first<SummaryRow>();

    const totalSessions = result?.total_sessions ?? 0;
    const totalCost = result?.total_cost ?? 0;

    return {
      totalSessions,
      activeUsers: result?.active_users ?? 0,
      totalCost,
      avgCost: totalSessions > 0 ? totalCost / totalSessions : 0,
      totalPrs: result?.total_prs ?? 0,
      statusBreakdown: {
        created: result?.created_count ?? 0,
        active: result?.active_count ?? 0,
        completed: result?.completed_count ?? 0,
        failed: result?.failed_count ?? 0,
        archived: result?.archived_count ?? 0,
        cancelled: result?.cancelled_count ?? 0,
      },
    };
  }

  async getTimeseries(filters: AnalyticsFilters): Promise<AnalyticsTimeseriesResponse> {
    const result = await this.db
      .prepare(
        `SELECT
           date(created_at / 1000, 'unixepoch') AS date,
           COALESCE(NULLIF(scm_login, ''), 'unknown') AS group_key,
           COUNT(*) AS count
         FROM sessions
         WHERE created_at >= ? AND created_at < ?
         GROUP BY date, group_key
         ORDER BY date ASC, group_key ASC`
      )
      .bind(filters.startAt, filters.endAt)
      .all<TimeseriesRow>();

    const series: AnalyticsTimeseriesResponse["series"] = [];
    for (const row of result.results ?? []) {
      const lastPoint = series[series.length - 1];
      if (lastPoint?.date === row.date) {
        lastPoint.groups[row.group_key] = row.count;
        continue;
      }

      series.push({
        date: row.date,
        groups: { [row.group_key]: row.count },
      });
    }

    return { series };
  }

  async getBreakdown(
    filters: AnalyticsFilters,
    by: AnalyticsBreakdownBy
  ): Promise<AnalyticsBreakdownResponse> {
    const groupExpression =
      by === "user"
        ? "COALESCE(NULLIF(scm_login, ''), 'unknown')"
        : "repo_owner || '/' || repo_name";

    const result = await this.db
      .prepare(
        `SELECT
           ${groupExpression} AS key,
           COUNT(*) AS sessions,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
           COALESCE(SUM(total_cost), 0) AS cost,
           COALESCE(SUM(pr_count), 0) AS prs,
           COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(
             AVG(CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN active_duration_ms END),
             0
           ) AS avg_duration,
           MAX(updated_at) AS last_active
         FROM sessions
         WHERE created_at >= ? AND created_at < ?
         GROUP BY key
         ORDER BY sessions DESC, key ASC`
      )
      .bind(filters.startAt, filters.endAt)
      .all<BreakdownRow>();

    const entries: AnalyticsBreakdownEntry[] = (result.results ?? []).map((row) => ({
      key: row.key,
      sessions: row.sessions,
      completed: row.completed,
      failed: row.failed,
      cancelled: row.cancelled,
      cost: row.cost,
      prs: row.prs,
      messageCount: row.message_count,
      avgDuration: row.avg_duration,
      lastActive: row.last_active,
    }));

    return { entries };
  }
}
