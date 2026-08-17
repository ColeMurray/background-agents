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
  effective_root_session_id: string;
  latest_updated_at: number;
  category: SessionInboxCategory;
}

interface InboxPageData {
  roots: Array<[string, InboxSessionRow[]]>;
  hasMore: boolean;
  nextCursor: SessionInboxCursor | null;
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
    const page = this.buildPageData(options.limit, result.results ?? []);
    const decorated = await decorateSessionEntries(
      this.db,
      page.roots.flatMap(([, lineage]) => lineage.map(toListItem))
    );
    return this.assemblePage(page, new Map(decorated.map((session) => [session.id, session])));
  }

  async snapshot(
    options: Omit<ListSessionInboxOptions, "category" | "cursor">
  ): Promise<ListSessionInboxSnapshotResult> {
    const result = await this.bindInboxSnapshotQuery(options).all<InboxSessionRow>();
    const rows = result.results ?? [];
    const pages = INBOX_CATEGORIES.map((category) =>
      this.buildPageData(
        options.limit,
        rows.filter((row) => row.category === category)
      )
    );
    const decorated = await decorateSessionEntries(
      this.db,
      pages.flatMap((page) => page.roots.flatMap(([, lineage]) => lineage.map(toListItem)))
    );
    const decoratedById = new Map(decorated.map((session) => [session.id, session]));
    return Object.fromEntries(
      INBOX_CATEGORIES.map((category, index) => [
        category,
        this.assemblePage(pages[index], decoratedById),
      ])
    ) as ListSessionInboxSnapshotResult;
  }

  private bindInboxQuery(options: ListSessionInboxOptions): SqlStatement {
    const { sql, params } = this.inboxCtes(options);
    const cursorCondition = options.cursor
      ? `AND (latest_updated_at < ? OR (latest_updated_at = ? AND effective_root_session_id < ?))`
      : "";

    return this.db
      .prepare(
        `${sql},
         selected_roots AS (
           SELECT effective_root_session_id, latest_updated_at, category
           FROM inbox_roots
           WHERE category = ? ${cursorCondition}
           ORDER BY latest_updated_at DESC, effective_root_session_id DESC
           LIMIT ?
         )
         SELECT effective_sessions.*, selected_roots.latest_updated_at, selected_roots.category
         FROM selected_roots
         JOIN effective_sessions USING (effective_root_session_id)
         ORDER BY selected_roots.latest_updated_at DESC,
                  selected_roots.effective_root_session_id DESC,
                  effective_sessions.updated_at DESC,
                  effective_sessions.id DESC`
      )
      .bind(
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

  private bindInboxSnapshotQuery(
    options: Omit<ListSessionInboxOptions, "category" | "cursor">
  ): SqlStatement {
    const { sql, params } = this.inboxCtes(options);
    return this.db
      .prepare(
        `${sql},
         ranked_roots AS (
           SELECT inbox_roots.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY category
                    ORDER BY latest_updated_at DESC, effective_root_session_id DESC
                  ) AS category_rank
           FROM inbox_roots
         ),
         selected_roots AS (
           SELECT effective_root_session_id, latest_updated_at, category
           FROM ranked_roots
           WHERE category_rank <= ?
         )
         SELECT effective_sessions.*, selected_roots.latest_updated_at, selected_roots.category
         FROM selected_roots
         JOIN effective_sessions USING (effective_root_session_id)
         ORDER BY selected_roots.category,
                  selected_roots.latest_updated_at DESC,
                  selected_roots.effective_root_session_id DESC,
                  effective_sessions.updated_at DESC,
                  effective_sessions.id DESC`
      )
      .bind(...params, options.limit + 1);
  }

  private inboxCtes(
    options: Pick<
      ListSessionInboxOptions,
      "createdByUserIds" | "excludeAutomationLineage" | "viewerUserId"
    >
  ): { sql: string; params: unknown[] } {
    const { conditions, params } = this.eligibility(options);
    return {
      sql: `WITH RECURSIVE eligible_sessions AS (
              SELECT sessions.*, ${unreadSql("sessions")} AS unread
              FROM sessions
              LEFT JOIN users viewer ON viewer.id = ?
              LEFT JOIN session_read_states read_state
                ON read_state.session_id = sessions.id
               AND read_state.user_id = viewer.id
              WHERE ${conditions.join(" AND ")}
            ),
            rerooted_sessions(id, effective_root_session_id) AS (
              SELECT eligible.id, eligible.id
              FROM eligible_sessions eligible
              WHERE eligible.parent_session_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM eligible_sessions parent
                  WHERE parent.id = eligible.parent_session_id
                )
              UNION
              SELECT child.id, rerooted_sessions.effective_root_session_id
              FROM rerooted_sessions
              JOIN eligible_sessions child ON child.parent_session_id = rerooted_sessions.id
            ),
            effective_sessions AS (
              SELECT eligible_sessions.*,
                     COALESCE(
                       (
                         SELECT rerooted.effective_root_session_id
                         FROM rerooted_sessions rerooted
                         WHERE rerooted.id = eligible_sessions.id
                       ),
                       eligible_sessions.root_session_id
                     ) AS effective_root_session_id
              FROM eligible_sessions
            ),
            inbox_roots AS (
              SELECT effective_root_session_id,
                     MAX(updated_at) AS latest_updated_at,
                     CASE
                       WHEN MAX(unread) = 1 THEN 'needs_attention'
                       WHEN MAX(status = 'active') = 1 THEN 'in_progress'
                       ELSE 'finished'
                     END AS category
              FROM effective_sessions
              GROUP BY effective_root_session_id
            )`,
      params: [options.viewerUserId, ...params],
    };
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

  private buildPageData(limit: number, rows: InboxSessionRow[]): InboxPageData {
    const rowsByRoot = new Map<string, InboxSessionRow[]>();
    for (const row of rows) {
      const lineage = rowsByRoot.get(row.effective_root_session_id) ?? [];
      lineage.push(row);
      rowsByRoot.set(row.effective_root_session_id, lineage);
    }

    const selectedRoots = [...rowsByRoot.entries()];
    const roots = selectedRoots.slice(0, limit);
    const hasMore = selectedRoots.length > limit;
    const last = roots.at(-1);
    return {
      roots,
      hasMore,
      nextCursor:
        hasMore && last
          ? { latestUpdatedAt: last[1][0].latest_updated_at, rootSessionId: last[0] }
          : null,
    };
  }

  private assemblePage(
    page: InboxPageData,
    decoratedById: Map<string, SessionListItem>
  ): ListSessionInboxResult {
    const items = page.roots.map(([rootId, lineage]) => {
      const rootRow = lineage.find(({ id }) => id === rootId) ?? lineage[0];
      const rootSession = decoratedById.get(rootRow.id)!;
      return {
        rootSession,
        descendantSessions: lineage
          .filter(({ id }) => id !== rootSession.id)
          .map(({ id }) => decoratedById.get(id)!),
      };
    });
    return { items, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }
}
