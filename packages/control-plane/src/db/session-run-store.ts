import type {
  AnalyticsRunOrderBy,
  AnalyticsScope,
  SessionRun,
} from "@open-inspect/shared/types/analytics";
import { spawnSourceSchema } from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { scopePredicate } from "./analytics-store";
import type { SessionViewer } from "@open-inspect/shared";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";
import { visibleSessionsPredicate } from "./session-visibility";

export interface ListSessionRunsOptions {
  startAt: number;
  endAt: number;
  limit: number;
  orderBy: AnalyticsRunOrderBy;
  scope: AnalyticsScope;
}

const runRowSchema = z.object({
  root_session_id: z.string(),
  title: z.string().nullable(),
  session_count: z.number(),
  max_spawn_depth: z.number(),
  total_cost: z.number(),
  total_prs: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  user_id: z.string().nullable(),
  scm_login: z.string().nullable(),
  spawn_source: spawnSourceSchema,
  automation_id: z.string().nullable(),
  repo_owner: z.string().nullable(),
  repo_name: z.string().nullable(),
});

const RUN_SELECT = `SELECT
  root.id AS root_session_id,
  COUNT(*) AS session_count,
  MAX(s.spawn_depth) AS max_spawn_depth,
  COALESCE(SUM(s.total_cost), 0) AS total_cost,
  COALESCE(SUM(s.pr_count), 0) AS total_prs,
  COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(s.reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(s.cache_write_tokens), 0) AS cache_write_tokens,
  MIN(s.created_at) AS created_at,
  MAX(s.updated_at) AS updated_at,
  root.title, root.user_id, root.scm_login, root.spawn_source, root.automation_id,
  root.repo_owner, root.repo_name
FROM sessions root
JOIN sessions s ON s.root_session_id = root.id`;

const RUN_GROUP = `GROUP BY root.id, root.title, root.user_id, root.scm_login, root.spawn_source,
  root.automation_id, root.repo_owner, root.repo_name`;

function toRun(value: unknown): SessionRun {
  const parsed = runRowSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid session run row");
  const row = parsed.data;
  return {
    rootSessionId: row.root_session_id,
    title: row.title,
    sessionCount: row.session_count,
    maxSpawnDepth: row.max_spawn_depth,
    totalCost: row.total_cost,
    totalPrs: row.total_prs,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id,
    scmLogin: row.scm_login,
    spawnSource: row.spawn_source,
    automationId: row.automation_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
  };
}

export class SessionRunStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly viewer: SessionViewer = { kind: "service", teamId: null },
    private readonly mode: TeamsEnforcementMode = "on"
  ) {}

  prepareList({ startAt, endAt, limit, orderBy, scope }: ListSessionRunsOptions): SqlStatement {
    const order = orderBy === "cost" ? "total_cost" : "created_at";
    const { sql, binds } = scopePredicate(scope, "root.spawn_source");
    const rootVisible = visibleSessionsPredicate("root", this.viewer, {
      mode: this.mode,
      excludePrivate: true,
    });
    const childVisible = visibleSessionsPredicate("s", this.viewer, {
      mode: this.mode,
      excludePrivate: true,
    });
    return this.db
      .prepare(
        `${RUN_SELECT}
         WHERE root.created_at >= ? AND root.created_at < ?
          ${sql} AND ${rootVisible.sql} AND ${childVisible.sql}
         ${RUN_GROUP}
         ORDER BY ${order} DESC, root_session_id ASC
         LIMIT ?`
      )
      .bind(startAt, endAt, ...binds, ...rootVisible.params, ...childVisible.params, limit);
  }

  decodeList(result: SqlResult): SessionRun[] {
    return (result.results ?? []).map(toRun);
  }

  async list(options: ListSessionRunsOptions): Promise<SessionRun[]> {
    return this.decodeList(await this.prepareList(options).all<unknown>());
  }

  async get(rootSessionId: string): Promise<SessionRun | null> {
    const rootVisible = visibleSessionsPredicate("root", this.viewer, {
      mode: this.mode,
      excludePrivate: true,
    });
    const childVisible = visibleSessionsPredicate("s", this.viewer, {
      mode: this.mode,
      excludePrivate: true,
    });
    const row = await this.db
      .prepare(
        `${RUN_SELECT} WHERE root.id = ? AND ${rootVisible.sql} AND ${childVisible.sql} ${RUN_GROUP}`
      )
      .bind(rootSessionId, ...rootVisible.params, ...childVisible.params)
      .first<unknown>();
    return row === null ? null : toRun(row);
  }
}
