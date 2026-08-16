import type {
  SessionInboxCategory,
  SessionInboxItem,
  SessionListItem,
} from "@open-inspect/shared/types/session-inbox";
import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import { decorateSessionEntries } from "./session-entry-decoration";
import type { SessionInboxCursor } from "./session-inbox-cursor";
import { readStateFromRow, unreadSql, type ViewerReadStateRow } from "./session-read-state";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface ListSessionInboxOptions {
  category: SessionInboxCategory;
  createdByUserIds?: readonly string[];
  excludeAutomationLineage?: boolean;
  viewerUserId: string;
  limit: number;
  cursor: SessionInboxCursor | null;
}

export interface ListSessionInboxResult {
  items: SessionInboxItem[];
  hasMore: boolean;
  nextCursor: SessionInboxCursor | null;
}

export type ListSessionInboxSnapshotResult = Record<SessionInboxCategory, ListSessionInboxResult>;

interface InboxSessionRow extends ViewerReadStateRow {
  id: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  base_branch: string | null;
  status: SessionStatus;
  parent_session_id: string | null;
  root_session_id: string;
  spawn_source: SpawnSource;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
  latest_updated_at: number;
}

const INBOX_CATEGORIES: SessionInboxCategory[] = ["needs_attention", "in_progress", "finished"];

function toListItem(row: InboxSessionRow): SessionListItem {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: row.base_branch,
    status: row.status,
    parentSessionId: row.parent_session_id,
    spawnSource: row.spawn_source,
    environmentId: row.environment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readState: readStateFromRow(row),
  };
}

export class SessionInboxStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(options: ListSessionInboxOptions): Promise<ListSessionInboxResult> {
    const result = await this.bindInboxQuery(options).all<InboxSessionRow>();
    return this.buildPage(options.limit, result.results ?? []);
  }

  async snapshot(
    options: Omit<ListSessionInboxOptions, "category" | "cursor">
  ): Promise<ListSessionInboxSnapshotResult> {
    const results = await this.db.batch<InboxSessionRow>(
      INBOX_CATEGORIES.map((category) =>
        this.bindInboxQuery({ ...options, category, cursor: null })
      )
    );
    const pages = await Promise.all(
      INBOX_CATEGORIES.map((_, index) =>
        this.buildPage(options.limit, results[index]?.results ?? [])
      )
    );
    return Object.fromEntries(
      INBOX_CATEGORIES.map((category, index) => [category, pages[index]])
    ) as ListSessionInboxSnapshotResult;
  }

  private bindInboxQuery(options: ListSessionInboxOptions): SqlStatement {
    const { conditions, params } = this.eligibility(options);
    const cursorCondition = options.cursor
      ? `AND (latest_updated_at < ? OR (latest_updated_at = ? AND root_session_id < ?))`
      : "";

    return this.db
      .prepare(
        `WITH eligible_sessions AS (
           SELECT sessions.*, ${unreadSql("sessions")} AS unread
           FROM sessions
           LEFT JOIN users viewer ON viewer.id = ?
           LEFT JOIN session_read_states read_state
             ON read_state.session_id = sessions.id
            AND read_state.user_id = viewer.id
           WHERE ${conditions.join(" AND ")}
         ),
         inbox_roots AS (
           SELECT root_session_id,
                  MAX(updated_at) AS latest_updated_at,
                  CASE
                    WHEN MAX(unread) = 1 THEN 'needs_attention'
                    WHEN MAX(status = 'active') = 1 THEN 'in_progress'
                    ELSE 'finished'
                  END AS category
           FROM eligible_sessions
           GROUP BY root_session_id
         ),
         selected_roots AS (
           SELECT root_session_id, latest_updated_at
           FROM inbox_roots
           WHERE category = ? ${cursorCondition}
           ORDER BY latest_updated_at DESC, root_session_id DESC
           LIMIT ?
         )
         SELECT eligible_sessions.*, selected_roots.latest_updated_at
         FROM selected_roots
         JOIN eligible_sessions USING (root_session_id)
         ORDER BY selected_roots.latest_updated_at DESC,
                  selected_roots.root_session_id DESC,
                  eligible_sessions.updated_at DESC,
                  eligible_sessions.id DESC`
      )
      .bind(
        options.viewerUserId,
        ...params,
        options.category,
        ...(options.cursor
          ? [
              options.cursor.latestUpdatedAt,
              options.cursor.latestUpdatedAt,
              options.cursor.rootSessionId,
            ]
          : []),
        options.limit + 1
      );
  }

  private eligibility(
    options: Pick<ListSessionInboxOptions, "createdByUserIds" | "excludeAutomationLineage">
  ): { conditions: string[]; params: unknown[] } {
    const conditions = ["sessions.status != 'archived'", "sessions.root_session_id IS NOT NULL"];
    const params: unknown[] = [];
    if (options.excludeAutomationLineage) {
      conditions.push(
        "sessions.automation_id IS NULL AND sessions.spawn_source NOT IN ('automation', 'github-bot')"
      );
    }
    if (options.createdByUserIds?.length) {
      conditions.push(
        `sessions.user_id IN (${options.createdByUserIds.map(() => "?").join(", ")})`
      );
      params.push(...options.createdByUserIds);
    }
    return { conditions, params };
  }

  private async buildPage(limit: number, rows: InboxSessionRow[]): Promise<ListSessionInboxResult> {
    const rowsByRoot = new Map<string, InboxSessionRow[]>();
    for (const row of rows) {
      const lineage = rowsByRoot.get(row.root_session_id) ?? [];
      lineage.push(row);
      rowsByRoot.set(row.root_session_id, lineage);
    }

    const selectedRoots = [...rowsByRoot.entries()];
    const pageRoots = selectedRoots.slice(0, limit);
    const decorated = await decorateSessionEntries(
      this.db,
      pageRoots.flatMap(([, lineage]) => lineage.map(toListItem))
    );
    const decoratedById = new Map(decorated.map((session) => [session.id, session]));
    const items = pageRoots.map(([rootId, lineage]) => {
      const rootRow = lineage.find(({ id }) => id === rootId) ?? lineage[0];
      const rootSession = decoratedById.get(rootRow.id)!;
      return {
        rootSession,
        descendantSessions: lineage
          .filter(({ id }) => id !== rootSession.id)
          .map(({ id }) => decoratedById.get(id)!),
      };
    });
    const hasMore = selectedRoots.length > limit;
    const last = pageRoots.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last
          ? {
              latestUpdatedAt: last[1][0].latest_updated_at,
              rootSessionId: last[0],
            }
          : null,
    };
  }
}
