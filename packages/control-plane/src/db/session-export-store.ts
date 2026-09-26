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
import type { RunsExportCursor, SessionExportCursor } from "./session-export-cursor";
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
const runsExportPageRowSchema = exportPageRowSchema.extend({
  root_session_id: z.string(),
  root_created_at: z.number(),
});

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
  /** Omitted for the original per-session ordering. */
  scope?: "sessions" | "runs";
  cursor: SessionExportCursor | RunsExportCursor | null;
  /** Page size; the store reads one extra row to answer hasMore. */
  limit: number;
  /** Inclusive lower bound on session creation, or root creation in runs scope (epoch ms). */
  createdAfter?: number;
  /** Inclusive upper bound on session creation, or root creation in runs scope (epoch ms). */
  createdBefore?: number;
}

export type ListSessionsForExportResult = { sessions: SessionExportRow[] } & (
  | { hasMore: false; nextCursor: null }
  | { hasMore: true; nextCursor: SessionExportCursor | RunsExportCursor }
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
    const runs = options.scope === "runs";

    if (options.cursor) {
      const cursor = options.cursor;
      const runsCursor = "rootCreatedAt" in cursor;
      if (runs !== runsCursor) throw new Error("Invalid cursor");
      if (runsCursor) {
        conditions.push("s.rowid <= ?", "root.rowid <= ?");
        bindings.push(cursor.snapshotMaxRowId, cursor.snapshotMaxRowId);
        conditions.push(
          `(root.created_at < ? OR (root.created_at = ? AND
            (s.root_session_id > ? OR (s.root_session_id = ? AND
              (s.spawn_depth > ? OR (s.spawn_depth = ? AND
                (s.created_at > ? OR (s.created_at = ? AND s.id > ?))))))))`
        );
        bindings.push(
          cursor.rootCreatedAt,
          cursor.rootCreatedAt,
          cursor.rootSessionId,
          cursor.rootSessionId,
          cursor.spawnDepth,
          cursor.spawnDepth,
          cursor.createdAt,
          cursor.createdAt,
          cursor.id
        );
      } else {
        conditions.push("sessions.rowid <= ?");
        bindings.push(cursor.snapshotMaxRowId);
        conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
        bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    } else {
      conditions.push(`${runs ? "s" : "sessions"}.rowid <= export_fence.max_row_id`);
    }
    if (options.createdAfter !== undefined) {
      conditions.push(`${runs ? "root." : ""}created_at >= ?`);
      bindings.push(options.createdAfter);
    }
    if (options.createdBefore !== undefined) {
      conditions.push(`${runs ? "root." : ""}created_at <= ?`);
      bindings.push(options.createdBefore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const snapshotColumn = firstPage ? ", export_fence.max_row_id AS snapshot_max_row_id" : "";
    const snapshotJoin = firstPage
      ? "CROSS JOIN (SELECT COALESCE(MAX(rowid), 0) AS max_row_id FROM sessions) export_fence"
      : "";
    const pageFrom = runs
      ? `FROM sessions root JOIN sessions s ON s.root_session_id = root.id
         ${snapshotJoin} ${where}
         ORDER BY root.created_at DESC, s.root_session_id ASC,
                  s.spawn_depth ASC, s.created_at ASC, s.id ASC`
      : `FROM sessions ${snapshotJoin} ${where} ORDER BY created_at DESC, id DESC`;
    const pageIds = `SELECT ${runs ? "s" : "sessions"}.id ${pageFrom} LIMIT ?`;
    const [sessionResult, repositoryResult, pullRequestResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${runs ? "s.*, root.created_at AS root_created_at" : "sessions.*"}${snapshotColumn} ${pageFrom} LIMIT ?`
        )
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

    const runRows = runs ? z.array(runsExportPageRowSchema).parse(sessionResult.results) : null;
    const rows = runRows ?? z.array(exportPageRowSchema).parse(sessionResult.results);
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

    const last = pageRows[pageRows.length - 1];
    const snapshotMaxRowId = options.cursor?.snapshotMaxRowId ?? rows[0]?.snapshot_max_row_id;
    if (snapshotMaxRowId === undefined) throw new Error("Session export page is missing its fence");
    if (runRows) {
      const lastRun = runRows[options.limit - 1];
      return {
        sessions,
        hasMore: true,
        nextCursor: {
          rootCreatedAt: lastRun.root_created_at,
          rootSessionId: lastRun.root_session_id,
          spawnDepth: lastRun.spawn_depth,
          createdAt: lastRun.created_at,
          id: lastRun.id,
          snapshotMaxRowId,
        },
      };
    }
    return {
      sessions,
      hasMore: true,
      nextCursor: { createdAt: last.created_at, id: last.id, snapshotMaxRowId },
    };
  }
}
