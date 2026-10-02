import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import type {
  AnalyticsBreakdownBy,
  AnalyticsBreakdownEntry,
  AnalyticsBreakdownResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
  AnalyticsScope,
  AnalyticsTokenTotals,
} from "@open-inspect/shared/types/analytics";
import {
  ANALYTICS_SCOPE_SPAWN_SOURCES,
  getCacheHitRatio,
} from "@open-inspect/shared/types/analytics";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import {
  getModelDisplayName,
  normalizeModelId,
  extractProviderAndModel,
} from "@open-inspect/shared/models";
import { HARNESS_CATALOG, isValidHarness } from "@open-inspect/shared/harnesses";
import { SUBSCRIPTION_PROVIDER_DISPLAY_METADATA } from "@open-inspect/shared/types/provider-accounts";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { MS_PER_DAY, utcDateFromDayIndex } from "./utc-day";
import { visibleSessionsPredicate, type SessionReadScope } from "./session-visibility";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";
import { z } from "zod";
import { projectAccessPredicate } from "./project-access-sql";

export interface AnalyticsFilters {
  startAt: number;
  endAt: number;
  scope: AnalyticsScope;
}

export function scopePredicate(
  scope: AnalyticsScope,
  column: string
): { sql: string; binds: SpawnSource[] } {
  if (scope === "all") return { sql: "", binds: [] };
  const binds = [...ANALYTICS_SCOPE_SPAWN_SOURCES[scope]];
  return { sql: `AND ${column} IN (${binds.map(() => "?").join(", ")})`, binds };
}

const tokenRowSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
});

function decodeTokens(row: z.infer<typeof tokenRowSchema> | undefined): AnalyticsTokenTotals {
  return {
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    reasoningTokens: row?.reasoning_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    cacheWriteTokens: row?.cache_write_tokens ?? 0,
  };
}

const summaryRowSchema = tokenRowSchema.extend({
  total_sessions: z.number(),
  active_users: z.number(),
  total_cost: z.number(),
  private_sessions_cost: z.number().nullable(),
  total_prs: z.number(),
  created_count: z.number(),
  active_count: z.number(),
  completed_count: z.number(),
  failed_count: z.number(),
  archived_count: z.number(),
  cancelled_count: z.number(),
});

type SummaryRow = z.infer<typeof summaryRowSchema>;

const timeseriesRowSchema = z.object({
  day_index: z.number(),
  group_key: z.string(),
  count: z.number(),
});

type TimeseriesRow = z.infer<typeof timeseriesRowSchema>;

const breakdownRowSchema = tokenRowSchema.extend({
  key: z.string().nullable(),
  display_name: z.string().nullable().optional(),
  sessions: z.number(),
  completed: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  cost: z.number(),
  prs: z.number(),
  message_count: z.number(),
  avg_duration: z.number(),
  last_active: z.number(),
});

const groupedBreakdownRowSchema = breakdownRowSchema.extend({
  key: z.string(),
  display_name: z.string().nullable(),
});
const billingRowSchema = z.object({
  model: z.string(),
  provider: z.string(),
  sessions: z.number(),
});

type BreakdownRow = z.infer<typeof breakdownRowSchema>;
type SqlBreakdownBy = Exclude<AnalyticsBreakdownBy, "provider">;

const NO_REPOSITORY_ANALYTICS_KEY = "No repository";

export function mergeBreakdownEntries(
  entries: AnalyticsBreakdownEntry[],
  keyOf: (entry: AnalyticsBreakdownEntry) => string,
  displayNameOf: (key: string) => string | undefined
): AnalyticsBreakdownEntry[] {
  const merged = new Map<string, AnalyticsBreakdownEntry>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const previous = merged.get(key);
    const displayName = displayNameOf(key);
    if (!previous) {
      merged.set(key, { ...entry, key, ...(displayName !== undefined && { displayName }) });
      continue;
    }
    const oldTerminal = previous.completed + previous.failed + previous.cancelled;
    const newTerminal = entry.completed + entry.failed + entry.cancelled;
    const terminal = oldTerminal + newTerminal;
    merged.set(key, {
      ...previous,
      sessions: previous.sessions + entry.sessions,
      completed: previous.completed + entry.completed,
      failed: previous.failed + entry.failed,
      cancelled: previous.cancelled + entry.cancelled,
      cost: previous.cost + entry.cost,
      prs: previous.prs + entry.prs,
      messageCount: previous.messageCount + entry.messageCount,
      inputTokens: previous.inputTokens + entry.inputTokens,
      outputTokens: previous.outputTokens + entry.outputTokens,
      reasoningTokens: previous.reasoningTokens + entry.reasoningTokens,
      cacheReadTokens: previous.cacheReadTokens + entry.cacheReadTokens,
      cacheWriteTokens: previous.cacheWriteTokens + entry.cacheWriteTokens,
      avgDuration: terminal
        ? (previous.avgDuration * oldTerminal + entry.avgDuration * newTerminal) / terminal
        : 0,
      lastActive: Math.max(previous.lastActive, entry.lastActive),
    });
  }
  return [...merged.values()].sort(
    (a, b) => b.sessions - a.sessions || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

export class AnalyticsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly readScope: SessionReadScope,
    private readonly mode: TeamsEnforcementMode
  ) {}

  private visible(alias: string) {
    return this.readScope.kind === "internal"
      ? { sql: "", params: [] }
      : visibleSessionsPredicate(alias, this.readScope, { mode: this.mode, excludePrivate: true });
  }

  async getSummary(filters: AnalyticsFilters): Promise<AnalyticsSummaryResponse> {
    const result = await this.prepareSummary(filters).all<SummaryRow>();
    return this.decodeSummary(result);
  }

  prepareSummary(filters: AnalyticsFilters): SqlStatement {
    const { sql, binds } = scopePredicate(filters.scope, "s.spawn_source");
    const visible = this.visible("s");
    const privileged = this.readScope.kind === "user" && isWorkspaceAdmin(this.readScope.roleKey);
    const privateScope = scopePredicate(filters.scope, "private.spawn_source");

    return this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_sessions,
           -- Uses user_id when available, falls back to scm_login for unlinked sessions.
           -- During the Phase 4→6 rollout window, the same person may appear under both
           -- keys (scm_login on old sessions, user_id on new), temporarily inflating this
           -- count. Resolves once the Phase 6 backfill populates user_id on historical rows.
           COUNT(DISTINCT COALESCE(s.user_id, NULLIF(s.scm_login, ''))) AS active_users,
           COALESCE(SUM(s.total_cost), 0) AS total_cost,
            ${
              privileged
                ? `(SELECT COALESCE(SUM(private.total_cost), 0) FROM sessions private
             WHERE private.visibility = 'private' AND private.created_at >= ? AND private.created_at < ?
             ${privateScope.sql})`
                : "NULL"
            } AS private_sessions_cost,
           COALESCE(SUM(pr_count), 0) AS total_prs,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END), 0) AS created_count,
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_count,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
           COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived_count,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
          FROM sessions s
          WHERE s.created_at >= ? AND s.created_at < ?
              ${sql} ${visible.sql ? `AND ${visible.sql}` : ""}`
      )
      .bind(
        ...(privileged ? [filters.startAt, filters.endAt, ...privateScope.binds] : []),
        filters.startAt,
        filters.endAt,
        ...binds,
        ...visible.params
      );
  }

  decodeSummary(result: SqlResult): AnalyticsSummaryResponse {
    const row = parseOptionalRow(result.results?.[0], summaryRowSchema, "analytics summary row");

    const totalSessions = row?.total_sessions ?? 0;
    const totalCost = row?.total_cost ?? 0;
    const tokens = decodeTokens(row);

    return {
      totalSessions,
      activeUsers: row?.active_users ?? 0,
      totalCost,
      privateSessionsCostUsd:
        this.readScope.kind === "user" && isWorkspaceAdmin(this.readScope.roleKey)
          ? (row?.private_sessions_cost ?? 0)
          : null,
      avgCost: totalSessions > 0 ? totalCost / totalSessions : 0,
      totalPrs: row?.total_prs ?? 0,
      ...tokens,
      cacheHitRatio: getCacheHitRatio(tokens),
      statusBreakdown: {
        created: row?.created_count ?? 0,
        active: row?.active_count ?? 0,
        completed: row?.completed_count ?? 0,
        failed: row?.failed_count ?? 0,
        archived: row?.archived_count ?? 0,
        cancelled: row?.cancelled_count ?? 0,
      },
    };
  }

  async getTimeseries(filters: AnalyticsFilters): Promise<AnalyticsTimeseriesResponse> {
    const result = await this.prepareTimeseries(filters).all<TimeseriesRow>();
    return this.decodeTimeseries(result);
  }

  prepareTimeseries(filters: AnalyticsFilters): SqlStatement {
    const { sql, binds } = scopePredicate(filters.scope, "s.spawn_source");
    const visible = this.visible("s");

    return this.db
      .prepare(
        `SELECT
           s.created_at / ${MS_PER_DAY} AS day_index,
           COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), '__unknown__') AS group_key,
           COUNT(*) AS count
         FROM sessions s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.created_at >= ? AND s.created_at < ?
              ${sql} ${visible.sql ? `AND ${visible.sql}` : ""}
         GROUP BY day_index, COALESCE(s.user_id, '__unlinked__' || COALESCE(s.scm_login, '__none__'))
         ORDER BY day_index ASC, group_key ASC`
      )
      .bind(filters.startAt, filters.endAt, ...binds, ...visible.params);
  }

  decodeTimeseries(result: SqlResult): AnalyticsTimeseriesResponse {
    const series: AnalyticsTimeseriesResponse["series"] = [];
    for (const row of parseRows(result.results, timeseriesRowSchema, "analytics timeseries row")) {
      const date = utcDateFromDayIndex(row.day_index);
      const lastPoint = series[series.length - 1];
      if (lastPoint?.date === date) {
        lastPoint.groups[row.group_key] = (lastPoint.groups[row.group_key] ?? 0) + row.count;
        continue;
      }

      series.push({
        date,
        groups: { [row.group_key]: row.count },
      });
    }

    return { series };
  }

  async getBreakdown(
    filters: AnalyticsFilters,
    by: AnalyticsBreakdownBy
  ): Promise<AnalyticsBreakdownResponse> {
    if (by === "provider") {
      const [models, billing] = await this.db.batch(this.prepareProviderBreakdown(filters));
      return this.decodeProviderBreakdown(this.decodeBreakdown(models, "model"), billing);
    }
    const result = await this.prepareBreakdown(filters, by).all<BreakdownRow>();
    return this.decodeBreakdown(result, by);
  }

  prepareProviderBreakdown(filters: AnalyticsFilters): [SqlStatement, SqlStatement] {
    return [this.prepareBreakdown(filters, "model"), this.prepareBilling(filters)];
  }

  prepareBilling(filters: AnalyticsFilters): SqlStatement {
    const { sql, binds } = scopePredicate(filters.scope, "s.spawn_source");
    const visible = this.visible("s");
    return this.db
      .prepare(
        `SELECT s.model AS model, a.provider AS provider, COUNT(*) AS sessions
       FROM sessions s
       JOIN session_model_provider_auth a ON a.session_id = s.id AND a.auth_mode = 'provider_account'
       WHERE s.created_at >= ? AND s.created_at < ?
           ${sql} ${visible.sql ? `AND ${visible.sql}` : ""}
       GROUP BY s.model, a.provider`
      )
      .bind(filters.startAt, filters.endAt, ...binds, ...visible.params);
  }

  prepareBreakdown(filters: AnalyticsFilters, by: SqlBreakdownBy): SqlStatement {
    const isUserBreakdown = by === "user";
    const projectAccess =
      this.readScope.kind === "internal"
        ? { sql: "1 = 1", params: [] }
        : this.readScope.kind === "user"
          ? projectAccessPredicate(this.readScope.userId, "read", "p")
          : { sql: "0 = 1", params: [] };
    const repoGroupExpression =
      "CASE WHEN s.repo_owner IS NULL OR s.repo_name IS NULL THEN NULL ELSE s.repo_owner || '/' || s.repo_name END";

    const groupExpression = {
      user: "COALESCE(s.user_id, NULLIF(s.scm_login, ''), '__unknown__')",
      repo: repoGroupExpression,
      model: "s.model",
      harness: "s.harness",
      spawnSource: "s.spawn_source",
      automation: "s.automation_id",
      project:
        "CASE WHEN s.project_id IS NULL THEN '__no_project__' ELSE COALESCE(p.id, '__restricted_project__') END",
    }[by];

    const displayNameSelect = isUserBreakdown
      ? "COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), 'Unknown user') AS display_name,"
      : by === "project"
        ? "CASE WHEN s.project_id IS NULL THEN 'No project' ELSE COALESCE(MAX(p.name), 'Restricted project') END AS display_name,"
        : by === "automation"
          ? "MAX(a.name) AS display_name,"
          : "NULL AS display_name,";

    const joinClause = isUserBreakdown
      ? "LEFT JOIN users u ON s.user_id = u.id"
      : by === "project"
        ? `LEFT JOIN projects p ON p.id = s.project_id AND ${projectAccess.sql}`
        : by === "automation"
          ? "LEFT JOIN automations a ON a.id = s.automation_id"
          : "";

    const orderTail = isUserBreakdown || by === "automation" ? "display_name ASC" : "key ASC";

    const { sql, binds } = scopePredicate(filters.scope, "s.spawn_source");
    const visible = this.visible("s");

    return this.db
      .prepare(
        `SELECT
           ${groupExpression} AS key,
           ${displayNameSelect}
           COUNT(*) AS sessions,
           COALESCE(SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN s.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
           COALESCE(SUM(total_cost), 0) AS cost,
           COALESCE(SUM(pr_count), 0) AS prs,
           COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(s.reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(s.cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(
             AVG(CASE WHEN s.status IN ('completed', 'failed', 'cancelled') THEN active_duration_ms END),
             0
           ) AS avg_duration,
           MAX(s.updated_at) AS last_active
         FROM sessions s
         ${joinClause}
         WHERE s.created_at >= ? AND s.created_at < ?
              ${sql} ${visible.sql ? `AND ${visible.sql}` : ""}
            ${by === "automation" ? "AND s.automation_id IS NOT NULL" : ""}
         GROUP BY key
         ORDER BY sessions DESC, ${orderTail}`
      )
      .bind(
        ...(by === "project" ? projectAccess.params : []),
        filters.startAt,
        filters.endAt,
        ...binds,
        ...visible.params
      );
  }

  decodeBreakdown(result: SqlResult, by: SqlBreakdownBy): AnalyticsBreakdownResponse {
    const entries: AnalyticsBreakdownEntry[] = parseRows(
      result.results,
      by === "repo" ? breakdownRowSchema : groupedBreakdownRowSchema,
      "analytics breakdown row"
    ).map((row) => ({
      key: row.key ?? NO_REPOSITORY_ANALYTICS_KEY,
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
      ...decodeTokens(row),
    }));

    if (by === "model")
      return {
        entries: mergeBreakdownEntries(
          entries,
          (entry) => normalizeModelId(entry.key),
          getModelDisplayName
        ),
      };
    if (by === "harness")
      return {
        entries: entries.map((entry) => ({
          ...entry,
          displayName: isValidHarness(entry.key) ? HARNESS_CATALOG[entry.key].label : entry.key,
        })),
      };
    return { entries };
  }

  decodeProviderBreakdown(
    models: AnalyticsBreakdownResponse,
    billing: SqlResult
  ): AnalyticsBreakdownResponse {
    const entries = mergeBreakdownEntries(
      models.entries,
      (entry) => extractProviderAndModel(entry.key).provider,
      (key) =>
        Object.entries(SUBSCRIPTION_PROVIDER_DISPLAY_METADATA).find(
          ([provider]) => provider === key
        )?.[1].displayName ?? key
    );
    const counts = new Map<string, number>();
    for (const row of parseRows(billing.results, billingRowSchema, "analytics billing row")) {
      const provider = extractProviderAndModel(normalizeModelId(row.model)).provider;
      if (provider === row.provider)
        counts.set(provider, (counts.get(provider) ?? 0) + row.sessions);
    }
    return {
      entries: entries.map((entry) => ({
        ...entry,
        subscriptionSessions: counts.get(entry.key) ?? 0,
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
