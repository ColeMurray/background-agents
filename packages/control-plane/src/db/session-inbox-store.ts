import type {
  SessionInboxCategory,
  SessionInboxItem,
  SessionListItem,
} from "@open-inspect/shared/types/session-inbox";
import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import { attachSessionListMetadata } from "./session-list-metadata";
import type { SessionInboxCursor } from "./session-inbox-cursor";
import { readStateFromRow, unreadSql, type ViewerReadStateRow } from "./session-read-state";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/** Viewer, filtering, and pagination inputs for an inbox query. */
export interface ListSessionInboxOptions {
  category: SessionInboxCategory;
  createdByUserIds?: readonly string[];
  excludeAutomatedSessions?: boolean;
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

/** Builds viewer-specific session inbox pages from the D1 session index. */
export class SessionInboxStore {
  constructor(private readonly db: SqlDatabase) {}

  /** List one inbox category with viewer-specific read state. */
  async list(options: ListSessionInboxOptions): Promise<ListSessionInboxResult> {
    const result = await this.bindInboxQuery(options).all<InboxSessionRow>();
    const page = this.buildPageData(options.limit, result.results ?? []);
    const sessionsWithMetadata = await attachSessionListMetadata(
      this.db,
      page.roots.flatMap(([, lineage]) => lineage.map(toListItem))
    );
    return this.assemblePage(
      page,
      new Map(sessionsWithMetadata.map((session) => [session.id, session]))
    );
  }

  /** List every inbox category with viewer-specific read state. */
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
    const sessionsWithMetadata = await attachSessionListMetadata(
      this.db,
      pages.flatMap((page) => page.roots.flatMap(([, lineage]) => lineage.map(toListItem)))
    );
    const sessionsById = new Map(sessionsWithMetadata.map((session) => [session.id, session]));
    return Object.fromEntries(
      INBOX_CATEGORIES.map((category, index) => [
        category,
        this.assemblePage(pages[index], sessionsById),
      ])
    ) as ListSessionInboxSnapshotResult;
  }

  /** Select one ordered category page plus one extra root for cursor metadata. */
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

  /** Select the first page of every category through one shared recursive traversal. */
  private bindInboxSnapshotQuery(
    options: Omit<ListSessionInboxOptions, "category" | "cursor">
  ): SqlStatement {
    const { sql, params } = this.inboxCtes(options);
    return this.db
      .prepare(
        `${sql},
         -- Rank roots independently so one query returns LIMIT + 1 for every category.
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

  /** Build the shared visibility, effective-root, and category aggregation CTEs. */
  private inboxCtes(
    options: Pick<
      ListSessionInboxOptions,
      "createdByUserIds" | "excludeAutomatedSessions" | "viewerUserId"
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
            -- Filtering can hide an ancestor. Re-root each resulting visible subtree
            -- while retaining the persisted root for uninterrupted lineages.
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
    options: Pick<ListSessionInboxOptions, "createdByUserIds" | "excludeAutomatedSessions">
  ): { conditions: string[]; params: unknown[] } {
    const conditions = ["sessions.status != 'archived'", "sessions.root_session_id IS NOT NULL"];
    const params: unknown[] = [];
    if (options.excludeAutomatedSessions) {
      conditions.push("sessions.spawn_source NOT IN ('automation', 'github-bot')");
    }
    if (options.createdByUserIds?.length) {
      conditions.push(
        `sessions.user_id IN (${options.createdByUserIds.map(() => "?").join(", ")})`
      );
      params.push(...options.createdByUserIds);
    }
    return { conditions, params };
  }

  /** Group ordered SQL rows into complete lineages and derive cursor metadata. */
  private buildPageData(limit: number, rows: InboxSessionRow[]): InboxPageData {
    const rowsByRoot = new Map<string, InboxSessionRow[]>();
    for (const row of rows) {
      const lineage = rowsByRoot.get(row.effective_root_session_id) ?? [];
      lineage.push(row);
      rowsByRoot.set(row.effective_root_session_id, lineage);
    }

    // SQL returns LIMIT + 1 complete roots so this layer derives pagination
    // metadata without counting or loading any additional lineage.
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

  /** Replace selected D1 rows with their metadata-enriched list items. */
  private assemblePage(
    page: InboxPageData,
    sessionsById: Map<string, SessionListItem>
  ): ListSessionInboxResult {
    const items = page.roots.map(([rootId, lineage]) => {
      const rootRow = lineage.find(({ id }) => id === rootId) ?? lineage[0];
      const rootSession = sessionsById.get(rootRow.id)!;
      return {
        rootSession,
        descendantSessions: lineage
          .filter(({ id }) => id !== rootSession.id)
          .map(({ id }) => sessionsById.get(id)!),
      };
    });
    return { items, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }
}
