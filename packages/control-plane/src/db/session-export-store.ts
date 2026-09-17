import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
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
  repoOwner: string | null;
  repoName: string | null;
  model: string;
  userId: string | null;
  automationId: string | null;
  messageCount: number;
  totalCost: number;
  activeDurationMs: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionExportRowRaw {
  id: string;
  title: string | null;
  status: SessionStatus;
  spawn_source: SpawnSource;
  repo_owner: string | null;
  repo_name: string | null;
  model: string;
  user_id: string | null;
  automation_id: string | null;
  message_count: number;
  total_cost: number;
  active_duration_ms: number;
  created_at: number;
  updated_at: number;
  snapshot_max_row_id?: number;
}

function toExportRow(row: SessionExportRowRaw): SessionExportRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.spawn_source,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    model: row.model,
    userId: row.user_id,
    automationId: row.automation_id,
    messageCount: row.message_count,
    totalCost: row.total_cost,
    activeDurationMs: row.active_duration_ms,
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
        `SELECT id, title, status, spawn_source, repo_owner, repo_name, model, user_id,
                automation_id, message_count, total_cost, active_duration_ms, created_at, updated_at${snapshotColumn}
         FROM sessions
         ${snapshotJoin}
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .bind(...bindings, options.limit + 1)
      .all<SessionExportRowRaw>();

    const rows = result.results ?? [];
    const hasMore = rows.length > options.limit;
    const sessions = (hasMore ? rows.slice(0, options.limit) : rows).map(toExportRow);
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
