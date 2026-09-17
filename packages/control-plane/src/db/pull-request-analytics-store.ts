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

import type { AnalyticsPullRequestsResponse } from "@open-inspect/shared/types/analytics";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { MS_PER_DAY, utcDateFromDayIndex } from "./utc-day";
import { z } from "zod";

/** `now` anchors the open-inventory age computation. */
export interface PullRequestAnalyticsFilters {
  startAt: number;
  endAt: number;
  now: number;
}

const funnelRowSchema = z.object({
  created: z.number(),
  open: z.number(),
  draft: z.number(),
  merged: z.number(),
  closed: z.number(),
});

const costRowSchema = z.object({
  cost: z.number(),
});

const mergeRowSchema = z.object({
  merged: z.number(),
  avg_time_to_merge_ms: z.number().nullable(),
});

const inventoryRowSchema = z.object({
  total: z.number(),
  avg_age_ms: z.number().nullable(),
});

const dailyCountRowSchema = z.object({
  day_index: z.number(),
  count: z.number(),
});

const repoRowSchema = z.object({
  key: z.string(),
  created: z.number(),
  merged: z.number(),
  closed: z.number(),
  avg_time_to_merge_ms: z.number().nullable(),
});

const sourceRowSchema = z.object({
  source: z.enum(["user", "agent", "automation", "github-bot", "linear-bot", "slack-bot"]),
  created: z.number(),
  merged: z.number(),
});

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

export class PullRequestAnalyticsStore {
  constructor(private readonly db: SqlDatabase) {}

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
    return this.decode(await this.db.batch(this.prepare(filters)));
  }

  prepare(filters: PullRequestAnalyticsFilters): SqlStatement[] {
    const prCreatedAt = prCreatedAtExpr();
    const cohortWindow = `${prCreatedAt} >= ? AND ${prCreatedAt} < ?`;
    const cohortBinds = [filters.startAt, filters.endAt];

    return [
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
          `SELECT ${prCreatedAt} / ${MS_PER_DAY} AS day_index, COUNT(*) AS count
             FROM session_pull_requests
             WHERE ${cohortWindow}
             GROUP BY day_index
             ORDER BY day_index ASC`
        )
        .bind(...cohortBinds),
      this.db
        .prepare(
          `SELECT merged_at / ${MS_PER_DAY} AS day_index, COUNT(*) AS count
             FROM session_pull_requests
             WHERE lifecycle_state = 'merged' AND merged_at >= ? AND merged_at < ?
             GROUP BY day_index
             ORDER BY day_index ASC`
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
    ];
  }

  decode(results: SqlResult[]): AnalyticsPullRequestsResponse {
    const [
      funnelResult,
      costResult,
      mergesResult,
      inventoryResult,
      createdResult,
      mergedResult,
      reposResult,
      sourcesResult,
    ] = results;

    const funnel = parseOptionalRow(funnelResult.results?.[0], funnelRowSchema, "PR funnel row");
    const cost = parseOptionalRow(costResult.results?.[0], costRowSchema, "PR cost row");
    const merges = parseOptionalRow(mergesResult.results?.[0], mergeRowSchema, "PR merge row");
    const inventory = parseOptionalRow(
      inventoryResult.results?.[0],
      inventoryRowSchema,
      "PR inventory row"
    );

    const timeseries = new Map<number, { created: number; merged: number }>();
    for (const row of parseRows(createdResult.results, dailyCountRowSchema, "PR created row")) {
      timeseries.set(row.day_index, { created: row.count, merged: 0 });
    }
    for (const row of parseRows(mergedResult.results, dailyCountRowSchema, "PR merged row")) {
      const point = timeseries.get(row.day_index);
      if (point) {
        point.merged = row.count;
      } else {
        timeseries.set(row.day_index, { created: 0, merged: row.count });
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
        .sort(([a], [b]) => a - b)
        .map(([dayIndex, counts]) => ({ date: utcDateFromDayIndex(dayIndex), ...counts })),
      repos: parseRows(reposResult.results, repoRowSchema, "PR repo row").map((row) => ({
        key: row.key,
        created: row.created,
        merged: row.merged,
        closed: row.closed,
        avgTimeToMergeMs: row.avg_time_to_merge_ms,
      })),
      sources: parseRows(sourcesResult.results, sourceRowSchema, "PR source row").map((row) => ({
        source: row.source,
        created: row.created,
        merged: row.merged,
      })),
    };
  }
}

function parseOptionalRow<Schema extends z.ZodType>(
  row: unknown,
  schema: Schema,
  name: string
): z.infer<Schema> | undefined {
  if (row === undefined) return undefined;
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new Error(`Invalid ${name}`);
  return parsed.data;
}

function parseRows<Schema extends z.ZodType>(
  rows: unknown[] | undefined,
  schema: Schema,
  name: string
): Array<z.infer<Schema>> {
  return (rows ?? []).map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error(`Invalid ${name}`);
    return parsed.data;
  });
}
