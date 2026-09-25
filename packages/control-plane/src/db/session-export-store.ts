import { extractProviderAndModel } from "@open-inspect/shared/models";
import { harnessIdSchema, type HarnessId } from "@open-inspect/shared/harnesses";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import {
  sessionStatusSchema,
  spawnSourceSchema,
  type ExportPullRequest,
  type SessionStatus,
  type SpawnSource,
} from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SessionExportCursor } from "./session-export-cursor";
import type { SqlDatabase } from "./sql-database";

/**
 * One exported session-trace record: the session-index projection deployers
 * need for analytics. Messages live in each session's Durable Object, not
 * D1, and are attached per session by the export route's runtime client.
 */
export interface SessionExportRow {
  id: string;
  title: string | null;
  status: SessionStatus;
  source: SpawnSource;
  spawnSource: SpawnSource;
  parentSessionId: string | null;
  rootSessionId: string | null;
  spawnDepth: number;
  harness: HarnessId;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  userId: string | null;
  scmLogin: string | null;
  automationId: string | null;
  automationRunId: string | null;
  environmentId: string | null;
  messageCount: number;
  prCount: number;
  totalCost: number;
  activeDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  repositories: SessionListRepository[];
  pullRequests: ExportPullRequest[];
  createdAt: number;
  updatedAt: number;
}

const exportRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  spawn_source: spawnSourceSchema,
  parent_session_id: z.string().nullable(),
  root_session_id: z.string().nullable(),
  spawn_depth: z.number(),
  harness: harnessIdSchema,
  repo_owner: z.string().nullable(),
  repo_name: z.string().nullable(),
  base_branch: z.string().nullable(),
  model: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  user_id: z.string().nullable(),
  scm_login: z.string().nullable(),
  automation_id: z.string().nullable(),
  automation_run_id: z.string().nullable(),
  environment_id: z.string().nullable(),
  message_count: z.number(),
  pr_count: z.number(),
  total_cost: z.number(),
  active_duration_ms: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  snapshot_max_row_id: z.number().optional(),
});

const exportRepositorySchema = z.object({
  session_id: z.string(),
  repo_owner: z.string(),
  repo_name: z.string(),
  repo_id: z.number().nullable(),
  base_branch: z.string(),
});

const exportPullRequestSchema = z.object({
  session_id: z.string(),
  repo_owner: z.string(),
  repo_name: z.string(),
  pr_number: z.number(),
  url: z.string(),
  lifecycle_state: z.enum(["open", "closed", "merged"]),
  is_draft: z.union([z.literal(0), z.literal(1)]),
  head_branch: z.string(),
  base_branch: z.string(),
  head_sha: z.string().nullable(),
  provider_created_at: z.number().nullable(),
  merged_at: z.number().nullable(),
  closed_at: z.number().nullable(),
});

type SessionExportRowRaw = z.infer<typeof exportRowSchema>;

function toExportRow(
  row: SessionExportRowRaw,
  repositories: SessionListRepository[],
  pullRequests: ExportPullRequest[]
): SessionExportRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.spawn_source,
    spawnSource: row.spawn_source,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    spawnDepth: row.spawn_depth,
    harness: row.harness,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: row.base_branch,
    model: row.model,
    provider: row.model === null ? null : extractProviderAndModel(row.model).provider,
    reasoningEffort: row.reasoning_effort,
    userId: row.user_id,
    scmLogin: row.scm_login,
    automationId: row.automation_id,
    automationRunId: row.automation_run_id,
    environmentId: row.environment_id,
    messageCount: row.message_count,
    prCount: row.pr_count,
    totalCost: row.total_cost,
    activeDurationMs: row.active_duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    repositories,
    pullRequests,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Filters and keyset pagination for an export page. */
export interface ListSessionsForExportOptions {
  cursor: SessionExportCursor | null;
  /** Page size; the store reads one extra row to answer hasMore. */
  limit: number;
  /** Inclusive lower bound on created_at (epoch ms). */
  createdAfter?: number;
  /** Inclusive upper bound on created_at (epoch ms). */
  createdBefore?: number;
}

export type ListSessionsForExportResult = { sessions: SessionExportRow[] } & (
  | { hasMore: false; nextCursor: null }
  | { hasMore: true; nextCursor: SessionExportCursor }
);

/**
 * Reads the session index newest-first behind an insertion fence so sessions
 * created during a paged export cannot extend it.
 */
export class SessionExportStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(options: ListSessionsForExportOptions): Promise<ListSessionsForExportResult> {
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    const firstPage = options.cursor === null;

    if (options.cursor) {
      conditions.push("sessions.rowid <= ?");
      bindings.push(options.cursor.snapshotMaxRowId);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      bindings.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    } else {
      conditions.push("sessions.rowid <= export_fence.max_row_id");
    }
    if (options.createdAfter !== undefined) {
      conditions.push("created_at >= ?");
      bindings.push(options.createdAfter);
    }
    if (options.createdBefore !== undefined) {
      conditions.push("created_at <= ?");
      bindings.push(options.createdBefore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const snapshotColumn = firstPage ? ", export_fence.max_row_id AS snapshot_max_row_id" : "";
    const snapshotJoin = firstPage
      ? "CROSS JOIN (SELECT COALESCE(MAX(rowid), 0) AS max_row_id FROM sessions) export_fence"
      : "";
    const result = await this.db
      .prepare(
        `SELECT id, title, status, spawn_source, parent_session_id, root_session_id, spawn_depth,
                 harness, repo_owner, repo_name, base_branch, model, reasoning_effort, user_id,
                 scm_login, automation_id, automation_run_id, environment_id, message_count, pr_count,
                 total_cost, active_duration_ms, input_tokens, output_tokens, reasoning_tokens,
                 cache_read_tokens, cache_write_tokens, created_at, updated_at${snapshotColumn}
         FROM sessions
         ${snapshotJoin}
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .bind(...bindings, options.limit + 1)
      .all();

    const rows = z.array(exportRowSchema).parse(result.results ?? []);
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const repositoriesBySession = new Map<string, SessionListRepository[]>();
    const pullRequestsBySession = new Map<string, ExportPullRequest[]>();

    for (let start = 0; start < pageRows.length; start += MAX_D1_QUERY_PARAMETERS) {
      const ids = pageRows.slice(start, start + MAX_D1_QUERY_PARAMETERS).map((row) => row.id);
      const placeholders = ids.map(() => "?").join(", ");
      const [repositoryResult, pullRequestResult] = await this.db.batch([
        this.db
          .prepare(
            `SELECT session_id, repo_owner, repo_name, repo_id, base_branch
             FROM session_repositories WHERE session_id IN (${placeholders})
             ORDER BY session_id, position`
          )
          .bind(...ids),
        this.db
          .prepare(
            `SELECT session_id, repo_owner, repo_name, pr_number, url, lifecycle_state, is_draft,
                    head_branch, base_branch, head_sha, provider_created_at, merged_at, closed_at
             FROM session_pull_requests WHERE session_id IN (${placeholders})
             ORDER BY session_id, pr_number, artifact_id`
          )
          .bind(...ids),
      ]);

      for (const row of z.array(exportRepositorySchema).parse(repositoryResult.results)) {
        const repositories = repositoriesBySession.get(row.session_id) ?? [];
        repositories.push({
          repoOwner: row.repo_owner,
          repoName: row.repo_name,
          repoId: row.repo_id,
          baseBranch: row.base_branch,
        });
        repositoriesBySession.set(row.session_id, repositories);
      }
      for (const row of z.array(exportPullRequestSchema).parse(pullRequestResult.results)) {
        const pullRequests = pullRequestsBySession.get(row.session_id) ?? [];
        pullRequests.push({
          repoOwner: row.repo_owner,
          repoName: row.repo_name,
          prNumber: row.pr_number,
          url: row.url,
          lifecycleState: row.lifecycle_state,
          isDraft: row.is_draft === 1,
          headBranch: row.head_branch,
          baseBranch: row.base_branch,
          headSha: row.head_sha,
          providerCreatedAt: row.provider_created_at,
          mergedAt: row.merged_at,
          closedAt: row.closed_at,
        });
        pullRequestsBySession.set(row.session_id, pullRequests);
      }
    }

    const sessions = pageRows.map((row) =>
      toExportRow(
        row,
        repositoriesBySession.get(row.id) ??
          (row.repo_owner && row.repo_name
            ? [
                {
                  repoOwner: row.repo_owner,
                  repoName: row.repo_name,
                  repoId: null,
                  baseBranch: row.base_branch ?? DEFAULT_BASE_BRANCH,
                },
              ]
            : []),
        pullRequestsBySession.get(row.id) ?? []
      )
    );
    if (!hasMore) return { sessions, hasMore: false, nextCursor: null };

    const last = sessions[sessions.length - 1];
    const snapshotMaxRowId = options.cursor?.snapshotMaxRowId ?? rows[0]?.snapshot_max_row_id;
    if (snapshotMaxRowId === undefined) throw new Error("Session export page is missing its fence");
    return {
      sessions,
      hasMore: true,
      nextCursor: { createdAt: last.createdAt, id: last.id, snapshotMaxRowId },
    };
  }
}
