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
import { getModelDisplayName, normalizeModelId } from "@open-inspect/shared/models";
import { HARNESS_CATALOG, isValidHarness } from "@open-inspect/shared/harnesses";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { MS_PER_DAY, utcDateFromDayIndex } from "./utc-day";
import { visibleSessionsPredicate, type SessionReadScope } from "./session-visibility";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";
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

const dimensionRowSchema = z.object({
  key: z.string(),
  created: z.number(),
  merged: z.number(),
  session_cost: z.number(),
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
  constructor(
    private readonly db: SqlDatabase,
    private readonly readScope: SessionReadScope,
    private readonly mode: TeamsEnforcementMode
  ) {}

  private visible(alias: string): { sql: string; params: unknown[] } {
    if (this.readScope.kind === "internal") return { sql: "", params: [] };
    const visible = visibleSessionsPredicate(alias, this.readScope, {
      mode: this.mode,
      excludePrivate: true,
    });
    return { sql: `(${alias}.id IS NULL OR ${visible.sql})`, params: visible.params };
  }

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
    const prCreatedAt = prCreatedAtExpr("p");
    const cohortWindow = `${prCreatedAt} >= ? AND ${prCreatedAt} < ?`;
    const cohortBinds = [filters.startAt, filters.endAt];
    const visible = this.visible("s");
    const whereVisible = visible.sql ? `AND ${visible.sql}` : "";
    const prSessions = `FROM session_pull_requests p LEFT JOIN sessions s ON s.id = p.session_id`;

    const statements = [
      this.db
        .prepare(
          `SELECT
               COUNT(*) AS created,
                COALESCE(SUM(CASE WHEN p.lifecycle_state = 'open' AND p.is_draft = 0 THEN 1 ELSE 0 END), 0) AS open,
                COALESCE(SUM(CASE WHEN p.lifecycle_state = 'open' AND p.is_draft = 1 THEN 1 ELSE 0 END), 0) AS draft,
                COALESCE(SUM(CASE WHEN p.lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged,
                COALESCE(SUM(CASE WHEN p.lifecycle_state = 'closed' THEN 1 ELSE 0 END), 0) AS closed
              ${prSessions}
               WHERE ${cohortWindow} ${whereVisible}`
        )
        .bind(...cohortBinds, ...visible.params),
      this.db
        .prepare(
          `SELECT COALESCE(SUM(s.total_cost), 0) AS cost
               FROM (SELECT DISTINCT p.session_id FROM session_pull_requests p WHERE ${cohortWindow}) cohort
               LEFT JOIN sessions s ON s.id = cohort.session_id
               WHERE 1 = 1 ${whereVisible}`
        )
        .bind(...cohortBinds, ...visible.params),
      this.db
        .prepare(
          `SELECT
               COUNT(*) AS merged,
                AVG(p.merged_at - ${prCreatedAt}) AS avg_time_to_merge_ms
              ${prSessions}
               WHERE p.lifecycle_state = 'merged' AND p.merged_at >= ? AND p.merged_at < ? ${whereVisible}`
        )
        .bind(filters.startAt, filters.endAt, ...visible.params),
      this.db
        .prepare(
          `SELECT
               COUNT(*) AS total,
               AVG(? - ${prCreatedAt}) AS avg_age_ms
              ${prSessions}
               WHERE p.lifecycle_state = 'open' ${whereVisible}`
        )
        .bind(filters.now, ...visible.params),
      this.db
        .prepare(
          `SELECT ${prCreatedAt} / ${MS_PER_DAY} AS day_index, COUNT(*) AS count
              ${prSessions}
               WHERE ${cohortWindow} ${whereVisible}
             GROUP BY day_index
             ORDER BY day_index ASC`
        )
        .bind(...cohortBinds, ...visible.params),
      this.db
        .prepare(
          `SELECT p.merged_at / ${MS_PER_DAY} AS day_index, COUNT(*) AS count
              ${prSessions}
               WHERE p.lifecycle_state = 'merged' AND p.merged_at >= ? AND p.merged_at < ? ${whereVisible}
             GROUP BY day_index
             ORDER BY day_index ASC`
        )
        .bind(filters.startAt, filters.endAt, ...visible.params),
      this.db
        .prepare(
          `SELECT
                p.repo_owner || '/' || p.repo_name AS key,
               COUNT(*) AS created,
                COALESCE(SUM(CASE WHEN p.lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged,
                COALESCE(SUM(CASE WHEN p.lifecycle_state = 'closed' THEN 1 ELSE 0 END), 0) AS closed,
                AVG(CASE WHEN p.lifecycle_state = 'merged' AND p.merged_at IS NOT NULL
                         THEN p.merged_at - ${prCreatedAt} END) AS avg_time_to_merge_ms
              ${prSessions}
               WHERE ${cohortWindow} ${whereVisible}
             GROUP BY key
             ORDER BY created DESC, key ASC`
        )
        .bind(...cohortBinds, ...visible.params),
      this.db
        .prepare(
          `SELECT
               s.spawn_source AS source,
               COUNT(*) AS created,
               COALESCE(SUM(CASE WHEN p.lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged
              ${prSessions}
               WHERE ${cohortWindow} ${whereVisible} AND s.spawn_source IS NOT NULL
             GROUP BY s.spawn_source
             ORDER BY created DESC, source ASC`
        )
        .bind(...cohortBinds, ...visible.params),
    ];
    for (const dimension of ["model", "harness"] as const) {
      const costVisible = this.visible("x");
      statements.push(
        this.db
          .prepare(
            `SELECT s.${dimension} AS key,
                    COUNT(*) AS created,
                    COALESCE(SUM(CASE WHEN p.lifecycle_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged,
                    (SELECT COALESCE(SUM(x.total_cost), 0)
                       FROM (SELECT DISTINCT cost_p.session_id FROM session_pull_requests cost_p
                             WHERE ${prCreatedAtExpr("cost_p")} >= ? AND ${prCreatedAtExpr("cost_p")} < ?) cohort
                       LEFT JOIN sessions x ON x.id = cohort.session_id
                       WHERE x.${dimension} = s.${dimension}
                         ${costVisible.sql ? `AND ${costVisible.sql}` : ""}) AS session_cost
               ${prSessions}
               WHERE ${cohortWindow} ${whereVisible} AND s.${dimension} IS NOT NULL
             GROUP BY s.${dimension}
             ORDER BY session_cost DESC, key ASC`
          )
          .bind(...cohortBinds, ...costVisible.params, ...cohortBinds, ...visible.params)
      );
    }
    return statements;
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
      modelsResult,
      harnessesResult,
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

    const models = new Map<string, AnalyticsPullRequestsResponse["models"][number]>();
    for (const row of parseRows(modelsResult.results, dimensionRowSchema, "PR model row")) {
      const key = normalizeModelId(row.key);
      const previous = models.get(key);
      if (previous) {
        previous.created += row.created;
        previous.merged += row.merged;
        previous.sessionCost += row.session_cost;
      } else {
        models.set(key, {
          key,
          displayName: getModelDisplayName(key),
          created: row.created,
          merged: row.merged,
          sessionCost: row.session_cost,
        });
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
      models: [...models.values()].sort(
        (a, b) => b.sessionCost - a.sessionCost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      ),
      harnesses: parseRows(harnessesResult.results, dimensionRowSchema, "PR harness row").map(
        (row) => ({
          key: row.key,
          displayName: isValidHarness(row.key) ? HARNESS_CATALOG[row.key].label : row.key,
          created: row.created,
          merged: row.merged,
          sessionCost: row.session_cost,
        })
      ),
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
