import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import {
  type ExportPullRequest,
  type SessionStatus,
  type SpawnSource,
} from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";
import { sessionRepositoryRowSchema, toSessionRepository } from "./session-list-metadata";
import { decodeSessionPullRequest } from "./session-pull-request-store";
import { sessionRowSchema, toSessionFields, type SessionRow } from "./session-row";
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
  model: string;
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

const exportPageRowSchema = sessionRowSchema.extend({ snapshot_max_row_id: z.number().optional() });

function toExportRow(
  row: SessionRow,
  repositories: SessionListRepository[],
  pullRequests: ExportPullRequest[]
): SessionExportRow {
  return {
    ...toSessionFields(row),
    source: row.spawn_source,
    rootSessionId: row.root_session_id,
    provider: extractProviderAndModel(row.model).provider,
    repositories,
    pullRequests,
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
    const pageFrom = `FROM sessions ${snapshotJoin} ${where} ORDER BY created_at DESC, id DESC`;
    const pageIds = `SELECT sessions.id ${pageFrom} LIMIT ?`;
    const [sessionResult, repositoryResult, pullRequestResult] = await this.db.batch([
      this.db
        .prepare(`SELECT sessions.*${snapshotColumn} ${pageFrom} LIMIT ?`)
        .bind(...bindings, options.limit + 1),
      this.db
        .prepare(
          `WITH page AS (${pageIds})
           SELECT sr.* FROM session_repositories sr JOIN page ON page.id = sr.session_id
           ORDER BY sr.session_id, sr.position`
        )
        .bind(...bindings, options.limit),
      this.db
        .prepare(
          `WITH page AS (${pageIds})
           SELECT pr.* FROM session_pull_requests pr JOIN page ON page.id = pr.session_id
           ORDER BY pr.session_id, pr.pr_number, pr.artifact_id`
        )
        .bind(...bindings, options.limit),
    ]);

    const rows = z.array(exportPageRowSchema).parse(sessionResult.results);
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const repositoriesBySession = new Map<string, SessionListRepository[]>();
    const pullRequestsBySession = new Map<string, ExportPullRequest[]>();

    for (const row of z.array(sessionRepositoryRowSchema).parse(repositoryResult.results)) {
      const repositories = repositoriesBySession.get(row.session_id) ?? [];
      repositories.push(toSessionRepository(row));
      repositoriesBySession.set(row.session_id, repositories);
    }
    for (const raw of pullRequestResult.results) {
      const row = decodeSessionPullRequest(raw);
      const pullRequests = pullRequestsBySession.get(row.sessionId) ?? [];
      const {
        repoOwner,
        repoName,
        prNumber,
        url,
        lifecycleState,
        isDraft,
        headBranch,
        baseBranch,
        headSha,
        providerCreatedAt,
        mergedAt,
        closedAt,
      } = row;
      pullRequests.push({
        repoOwner,
        repoName,
        prNumber,
        url,
        lifecycleState,
        isDraft,
        headBranch,
        baseBranch,
        headSha,
        providerCreatedAt,
        mergedAt,
        closedAt,
      });
      pullRequestsBySession.set(row.sessionId, pullRequests);
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
