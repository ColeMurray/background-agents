import type {
  AnalyticsBreakdownBy,
  AnalyticsBreakdownEntry,
  AnalyticsBreakdownResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
  SpawnSource,
} from "@open-inspect/shared";

/** Spawn sources that represent direct human-initiated sessions. */
export const HUMAN_SPAWN_SOURCES: SpawnSource[] = ["user", "slack-bot", "linear-bot", "github-bot"];

export interface AnalyticsFilters {
  startAt: number;
  endAt: number;
  spawnSources?: SpawnSource[];
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
  display_name?: string;
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
    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");

    const result = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_sessions,
           -- Uses user_id when available, falls back to scm_login for unlinked sessions.
           -- During the Phase 4→6 rollout window, the same person may appear under both
           -- keys (scm_login on old sessions, user_id on new), temporarily inflating this
           -- count. Resolves once the Phase 6 backfill populates user_id on historical rows.
           COUNT(DISTINCT COALESCE(user_id, NULLIF(scm_login, ''))) AS active_users,
           COALESCE(SUM(total_cost), 0) AS total_cost,
           COALESCE(SUM(pr_count), 0) AS total_prs,
           COALESCE(SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END), 0) AS created_count,
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_count,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
           COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived_count,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
         FROM sessions
         WHERE created_at >= ? AND created_at < ?
           AND spawn_source IN (${placeholders})`
      )
      .bind(filters.startAt, filters.endAt, ...sources)
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
    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");

    const result = await this.db
      .prepare(
        `SELECT
           date(s.created_at / 1000, 'unixepoch') AS date,
           COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), '__unknown__') AS group_key,
           COUNT(*) AS count
         FROM sessions s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.created_at >= ? AND s.created_at < ?
           AND s.spawn_source IN (${placeholders})
         GROUP BY date, COALESCE(s.user_id, '__unlinked__' || COALESCE(s.scm_login, '__none__'))
         ORDER BY date ASC, group_key ASC`
      )
      .bind(filters.startAt, filters.endAt, ...sources)
      .all<TimeseriesRow>();

    const series: AnalyticsTimeseriesResponse["series"] = [];
    for (const row of result.results ?? []) {
      const lastPoint = series[series.length - 1];
      if (lastPoint?.date === row.date) {
        lastPoint.groups[row.group_key] = (lastPoint.groups[row.group_key] ?? 0) + row.count;
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
    const isUserBreakdown = by === "user";

    const groupExpression = isUserBreakdown
      ? "COALESCE(s.user_id, NULLIF(s.scm_login, ''), '__unknown__')"
      : "s.repo_owner || '/' || s.repo_name";

    const displayNameSelect = isUserBreakdown
      ? "COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), 'Unknown user') AS display_name,"
      : "";

    const joinClause = isUserBreakdown ? "LEFT JOIN users u ON s.user_id = u.id" : "";

    const orderTail = isUserBreakdown ? "display_name ASC" : "key ASC";

    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");

    const result = await this.db
      .prepare(
        `SELECT
           ${groupExpression} AS key,
           ${displayNameSelect}
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
           MAX(s.updated_at) AS last_active
         FROM sessions s
         ${joinClause}
         WHERE s.created_at >= ? AND s.created_at < ?
           AND s.spawn_source IN (${placeholders})
         GROUP BY key
         ORDER BY sessions DESC, ${orderTail}`
      )
      .bind(filters.startAt, filters.endAt, ...sources)
      .all<BreakdownRow>();

    const entries: AnalyticsBreakdownEntry[] = (result.results ?? []).map((row) => ({
      key: row.key,
      ...(row.display_name != null && { displayName: row.display_name }),
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
