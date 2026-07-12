/**
 * PR value-stream analytics over session_pull_requests
 * (docs/pr-analytics-design.md). Kept separate from AnalyticsStore because
 * its contract differs: the universe is pull requests, not sessions, and no
 * spawn-source filter applies — automation-produced PRs are output too,
 * surfaced via the source dimension instead.
 *
 * All reads execute in one D1 batch, so every metric in a response is
 * computed from the same database snapshot even while lifecycle webhooks are
 * landing concurrently.
 */

import type { AnalyticsPullRequestsResponse, SpawnSource } from "@open-inspect/shared";

/** `now` anchors the open-inventory age computation. */
export interface PullRequestAnalyticsFilters {
  startAt: number;
  endAt: number;
  now: number;
}

interface FunnelRow {
  created: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
}

interface CostRow {
  cost: number;
}

interface MergeRow {
  merged: number;
  avg_time_to_merge_ms: number | null;
}

interface InventoryRow {
  total: number;
  avg_age_ms: number | null;
}

interface DailyCountRow {
  date: string;
  count: number;
}

interface RepoRow {
  key: string;
  created: number;
  merged: number;
  closed: number;
  avg_time_to_merge_ms: number | null;
}

interface SourceRow {
  source: SpawnSource;
  created: number;
  merged: number;
}

/**
 * When a PR entered the world, for windowing and cycle time. The row's own
 * created_at is the fallback for rows that predate the provider_created_at
 * column: exact for creation-path rows (the record is written at PR creation),
 * approximate for webhook-fallback inserts until read-through repairs them.
 */
function prCreatedAtExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `COALESCE(${prefix}provider_created_at, ${prefix}created_at)`;
}

function rows<T>(result: D1Result): T[] {
  return (result.results ?? []) as T[];
}

function firstRow<T>(result: D1Result): T | undefined {
  return rows<T>(result)[0];
}

export class PullRequestAnalyticsStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Two windows with different populations: the funnel/repos/sources cohort is
   * "PRs created in window" (open PRs report as still-open, not failures),
   * while mergedInWindow/avgTimeToMergeMs use "PRs merged in window" so recent
   * merge latency isn't biased by old cohorts. Open inventory ignores the
   * window entirely — it is the WIP as of now.
   *
   * Merged rows that predate the merged_at column are absent from the
   * merged-in-window metrics until read-through repairs them; they still count
   * in the cohort funnel.
   */
  async get(filters: PullRequestAnalyticsFilters): Promise<AnalyticsPullRequestsResponse> {
    const prCreatedAt = prCreatedAtExpr();
    const cohortWindow = `${prCreatedAt} >= ? AND ${prCreatedAt} < ?`;
    const cohortBinds = [filters.startAt, filters.endAt];

    const [
      funnelResult,
      costResult,
      mergesResult,
      inventoryResult,
      createdResult,
      mergedResult,
      reposResult,
      sourcesResult,
    ] = await this.db.batch([
      this.db
        .prepare(
          `SELECT
               COUNT(*) AS created,
               COALESCE(SUM(CASE WHEN lifecycle_state = 'open' AND is_draft = 0 THEN 1 ELSE 0 END), 0) AS open,
               COALESCE(SUM(CASE WHEN lifecycle_state = 'open' AND is_draft = 1 THEN 1 ELSE 0 END), 0) AS draft,
               COALESCE(SUM(CASE WHEN lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged,
               COALESCE(SUM(CASE WHEN lifecycle_state = 'closed' THEN 1 ELSE 0 END), 0) AS closed
             FROM session_pull_requests
             WHERE ${cohortWindow}`
        )
        .bind(...cohortBinds),
      this.db
        .prepare(
          `SELECT COALESCE(SUM(total_cost), 0) AS cost
             FROM sessions
             WHERE id IN (
               SELECT DISTINCT session_id FROM session_pull_requests WHERE ${cohortWindow}
             )`
        )
        .bind(...cohortBinds),
      this.db
        .prepare(
          `SELECT
               COUNT(*) AS merged,
               AVG(merged_at - ${prCreatedAt}) AS avg_time_to_merge_ms
             FROM session_pull_requests
             WHERE lifecycle_state = 'merged' AND merged_at >= ? AND merged_at < ?`
        )
        .bind(filters.startAt, filters.endAt),
      this.db
        .prepare(
          `SELECT
               COUNT(*) AS total,
               AVG(? - ${prCreatedAt}) AS avg_age_ms
             FROM session_pull_requests
             WHERE lifecycle_state = 'open'`
        )
        .bind(filters.now),
      this.db
        .prepare(
          `SELECT date(${prCreatedAt} / 1000, 'unixepoch') AS date, COUNT(*) AS count
             FROM session_pull_requests
             WHERE ${cohortWindow}
             GROUP BY date
             ORDER BY date ASC`
        )
        .bind(...cohortBinds),
      this.db
        .prepare(
          `SELECT date(merged_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
             FROM session_pull_requests
             WHERE lifecycle_state = 'merged' AND merged_at >= ? AND merged_at < ?
             GROUP BY date
             ORDER BY date ASC`
        )
        .bind(filters.startAt, filters.endAt),
      this.db
        .prepare(
          `SELECT
               repo_owner || '/' || repo_name AS key,
               COUNT(*) AS created,
               COALESCE(SUM(CASE WHEN lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged,
               COALESCE(SUM(CASE WHEN lifecycle_state = 'closed' THEN 1 ELSE 0 END), 0) AS closed,
               AVG(CASE WHEN lifecycle_state = 'merged' AND merged_at IS NOT NULL
                        THEN merged_at - ${prCreatedAt} END) AS avg_time_to_merge_ms
             FROM session_pull_requests
             WHERE ${cohortWindow}
             GROUP BY key
             ORDER BY created DESC, key ASC`
        )
        .bind(...cohortBinds),
      this.db
        .prepare(
          `SELECT
               s.spawn_source AS source,
               COUNT(*) AS created,
               COALESCE(SUM(CASE WHEN p.lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged
             FROM session_pull_requests p
             JOIN sessions s ON p.session_id = s.id
             WHERE ${prCreatedAtExpr("p")} >= ? AND ${prCreatedAtExpr("p")} < ?
             GROUP BY s.spawn_source
             ORDER BY created DESC, source ASC`
        )
        .bind(...cohortBinds),
    ]);

    const funnel = firstRow<FunnelRow>(funnelResult);
    const cost = firstRow<CostRow>(costResult);
    const merges = firstRow<MergeRow>(mergesResult);
    const inventory = firstRow<InventoryRow>(inventoryResult);

    const timeseries = new Map<string, { created: number; merged: number }>();
    for (const row of rows<DailyCountRow>(createdResult)) {
      timeseries.set(row.date, { created: row.count, merged: 0 });
    }
    for (const row of rows<DailyCountRow>(mergedResult)) {
      const point = timeseries.get(row.date);
      if (point) {
        point.merged = row.count;
      } else {
        timeseries.set(row.date, { created: 0, merged: row.count });
      }
    }

    return {
      funnel: {
        created: funnel?.created ?? 0,
        open: funnel?.open ?? 0,
        draft: funnel?.draft ?? 0,
        merged: funnel?.merged ?? 0,
        closed: funnel?.closed ?? 0,
      },
      prSessionCost: cost?.cost ?? 0,
      mergedInWindow: merges?.merged ?? 0,
      avgTimeToMergeMs: merges?.avg_time_to_merge_ms ?? null,
      openInventory: {
        total: inventory?.total ?? 0,
        avgAgeMs: inventory?.avg_age_ms ?? null,
      },
      timeseries: Array.from(timeseries.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, counts]) => ({ date, ...counts })),
      repos: rows<RepoRow>(reposResult).map((row) => ({
        key: row.key,
        created: row.created,
        merged: row.merged,
        closed: row.closed,
        avgTimeToMergeMs: row.avg_time_to_merge_ms,
      })),
      sources: rows<SourceRow>(sourcesResult).map((row) => ({
        source: row.source,
        created: row.created,
        merged: row.merged,
      })),
    };
  }
}
