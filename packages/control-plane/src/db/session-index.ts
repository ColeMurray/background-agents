import type {
  PullRequestSummary,
  SessionListRepository,
  SessionStatus,
  SpawnSource,
} from "@open-inspect/shared";
import { SessionPullRequestStore } from "./session-pull-request-store";

/**
 * One member of a session's repository set — the identity subset of the
 * shared SessionRepositoryState (no git state; D1 doesn't store it).
 * Ordered — array position is the persisted `position` column ([0] =
 * primary, mirrored into the scalar repo_owner/repo_name columns). Aliases
 * the shared wire type so Session.repositories and this share one shape.
 */
export type SessionIndexRepository = SessionListRepository;
const SESSION_DECORATION_BATCH_SIZE = 90;

export interface SessionEntry {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  model: string;
  reasoningEffort: string | null;
  baseBranch: string | null;
  status: SessionStatus;
  parentSessionId?: string | null;
  rootSessionId?: string;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  automationId?: string | null;
  automationRunId?: string | null;
  scmLogin?: string | null;
  userId?: string | null;
  totalCost?: number;
  activeDurationMs?: number;
  messageCount?: number;
  prCount?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Ordered member list; [0] = primary. Absent on pre-feature sessions —
   * consumers synthesize from repoOwner/repoName.
   */
  repositories?: SessionIndexRepository[];
  /**
   * The environment this session was launched from (provenance), or null for
   * repo-launched/ad-hoc sessions. PR-12 renders it on the session list.
   */
  environmentId?: string | null;
  /**
   * Per-status PR counts from session_pull_requests; absent when the session
   * has no tracked PRs. Attached by list() for the global sidebar.
   */
  pullRequestSummary?: PullRequestSummary;
}

interface SessionRepositoryRow {
  session_id: string;
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
}

interface SessionRow {
  id: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: SessionStatus;
  parent_session_id: string | null;
  root_session_id: string | null;
  spawn_source: SpawnSource;
  spawn_depth: number;
  automation_id: string | null;
  automation_run_id: string | null;
  scm_login: string | null;
  user_id: string | null;
  total_cost: number;
  active_duration_ms: number;
  message_count: number;
  pr_count: number;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ListSessionsOptions {
  status?: SessionStatus;
  excludeStatus?: SessionStatus;
  repoOwner?: string;
  repoName?: string;
  createdByUserIds?: readonly string[];
  limit?: number;
  offset?: number;
}

export interface ListSessionsResult {
  sessions: SessionEntry[];
  hasMore: boolean;
}

export interface SidebarSessionCursor {
  activityAt: number;
  rootSessionId: string;
}

export interface ListSidebarSessionsOptions {
  createdByUserIds?: readonly string[];
  limit?: number;
  cursor?: SidebarSessionCursor;
}

export interface ListSidebarSessionsResult {
  trees: Array<{
    rootSessionId: string;
    activityAt: number;
    sessions: SessionEntry[];
  }>;
  nextCursor: SidebarSessionCursor | null;
}

function toEntry(row: SessionRow): SessionEntry {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    baseBranch: row.base_branch,
    status: row.status,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id ?? row.id,
    spawnSource: row.spawn_source,
    spawnDepth: row.spawn_depth,
    automationId: row.automation_id,
    automationRunId: row.automation_run_id,
    scmLogin: row.scm_login,
    userId: row.user_id,
    totalCost: row.total_cost,
    activeDurationMs: row.active_duration_ms,
    messageCount: row.message_count,
    prCount: row.pr_count,
    environmentId: row.environment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRepoIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeSessionRepository(session: SessionEntry): {
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
} {
  const repoOwner = normalizeRepoIdentifier(session.repoOwner);
  const repoName = normalizeRepoIdentifier(session.repoName);

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Session repository must include repoOwner and repoName together");
  }

  return {
    repoOwner,
    repoName,
    baseBranch: repoOwner && repoName ? session.baseBranch : null,
  };
}

export class SessionIndexStore {
  constructor(private readonly db: D1Database) {}

  async create(session: SessionEntry): Promise<void> {
    const repository = normalizeSessionRepository(session);
    let rootSessionId = session.rootSessionId ?? session.id;
    if (session.parentSessionId && !session.rootSessionId) {
      const parent = await this.get(session.parentSessionId);
      rootSessionId = parent?.rootSessionId ?? parent?.id ?? session.id;
    }

    const sessionStmt = this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, title, repo_owner, repo_name, model, reasoning_effort, base_branch, status, parent_session_id, root_session_id, spawn_source, spawn_depth, automation_id, automation_run_id, scm_login, user_id, environment_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        session.id,
        session.title,
        repository.repoOwner,
        repository.repoName,
        session.model,
        session.reasoningEffort,
        repository.baseBranch,
        session.status,
        session.parentSessionId ?? null,
        rootSessionId,
        session.spawnSource ?? "user",
        session.spawnDepth ?? 0,
        session.automationId ?? null,
        session.automationRunId ?? null,
        session.scmLogin ?? null,
        session.userId ?? null,
        session.environmentId ?? null,
        session.createdAt,
        session.updatedAt
      );

    const repositoryStmts = (session.repositories ?? []).map((repo, position) =>
      this.db
        .prepare(
          `INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          session.id,
          position,
          normalizeRepoIdentifier(repo.repoOwner),
          normalizeRepoIdentifier(repo.repoName),
          repo.repoId,
          repo.baseBranch
        )
    );

    const results = await this.db.batch([sessionStmt, ...repositoryStmts]);

    // INSERT OR IGNORE swallows every constraint violation, which would leave
    // the session invisible to dashboards while the DO proceeds. Session ids
    // are always freshly generated, so a skipped insert is a bug — surface it;
    // initialize.ts relies on D1 failures being caught before sandbox spawn.
    if ((results[0]?.meta?.changes ?? 0) === 0) {
      throw new Error(
        `Session index insert was skipped for session ${session.id} (duplicate id or constraint violation)`
      );
    }
  }

  async get(id: string): Promise<SessionEntry | null> {
    const result = await this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(id)
      .first<SessionRow>();

    return result ? toEntry(result) : null;
  }

  /**
   * Whether the session exists and the repository is in its repository set
   * (the scalar primary mirror or a session_repositories row). This is the
   * webhook branch-fallback gate (design §5.2): a branch-derived insert may
   * only attach to a session already associated with the event's repository.
   * Case-insensitive — provider repo identifiers are case-insensitive while
   * stored casing is display-canonical.
   */
  async isRepositoryAssociated(
    sessionId: string,
    repoOwner: string,
    repoName: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS ok FROM sessions
         WHERE id = ?1
           AND (
             (LOWER(repo_owner) = LOWER(?2) AND LOWER(repo_name) = LOWER(?3))
             OR EXISTS (
               SELECT 1 FROM session_repositories sr
               WHERE sr.session_id = sessions.id
                 AND LOWER(sr.repo_owner) = LOWER(?2)
                 AND LOWER(sr.repo_name) = LOWER(?3)
             )
           )`
      )
      .bind(sessionId, repoOwner, repoName)
      .first<{ ok: number }>();

    return row !== null;
  }

  async list(options: ListSessionsOptions = {}): Promise<ListSessionsResult> {
    const {
      status,
      excludeStatus,
      repoOwner,
      repoName,
      createdByUserIds,
      limit = 50,
      offset = 0,
    } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (excludeStatus) {
      conditions.push("status != ?");
      params.push(excludeStatus);
    }

    // Repo filters match against the membership table so a session is found
    // through ANY member, not just the scalar primary mirror. The scalar arm
    // is the fallback for pre-feature sessions without member rows.
    const normalizedRepoOwner = normalizeRepoIdentifier(repoOwner);
    const normalizedRepoName = normalizeRepoIdentifier(repoName);
    if (normalizedRepoOwner || normalizedRepoName) {
      const memberConditions: string[] = [];
      const scalarConditions: string[] = [];
      const repoFilterParams: unknown[] = [];
      if (normalizedRepoOwner) {
        memberConditions.push("sr.repo_owner = ?");
        scalarConditions.push("repo_owner = ?");
        repoFilterParams.push(normalizedRepoOwner);
      }
      if (normalizedRepoName) {
        memberConditions.push("sr.repo_name = ?");
        scalarConditions.push("repo_name = ?");
        repoFilterParams.push(normalizedRepoName);
      }
      conditions.push(
        `(EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = sessions.id AND ${memberConditions.join(" AND ")}) OR (${scalarConditions.join(" AND ")}))`
      );
      params.push(...repoFilterParams, ...repoFilterParams);
    }

    if (createdByUserIds?.length) {
      conditions.push(`user_id IN (${createdByUserIds.map(() => "?").join(", ")})`);
      params.push(...createdByUserIds);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get paginated results
    const result = await this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit + 1, offset)
      .all<SessionRow>();

    const rows = result.results || [];
    const sessions = await this.decorateEntries(rows.slice(0, limit).map(toEntry));

    return {
      sessions,
      hasMore: rows.length > limit,
    };
  }

  async listSidebar(options: ListSidebarSessionsOptions = {}): Promise<ListSidebarSessionsResult> {
    const { createdByUserIds, limit = 25, cursor } = options;
    const conditions = ["status != 'archived'", "root_session_id IS NOT NULL"];
    const params: unknown[] = [];

    if (createdByUserIds?.length) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM sessions root
          WHERE root.id = sessions.root_session_id
            AND root.user_id IN (${createdByUserIds.map(() => "?").join(", ")})
        )`
      );
      params.push(...createdByUserIds);
    }

    const having = cursor
      ? "HAVING MAX(updated_at) < ? OR (MAX(updated_at) = ? AND root_session_id < ?)"
      : "";
    if (cursor) {
      params.push(cursor.activityAt, cursor.activityAt, cursor.rootSessionId);
    }

    const result = await this.db
      .prepare(
        `SELECT root_session_id, MAX(updated_at) AS activity_at
         FROM sessions
         WHERE ${conditions.join(" AND ")}
         GROUP BY root_session_id
         ${having}
         ORDER BY activity_at DESC, root_session_id DESC
         LIMIT ?`
      )
      .bind(...params, limit + 1)
      .all<{ root_session_id: string; activity_at: number }>();

    const pageRoots = (result.results ?? []).slice(0, limit);
    if (pageRoots.length === 0) {
      return { trees: [], nextCursor: null };
    }

    const rootIds = pageRoots.map((row) => row.root_session_id);
    const sessionResult = await this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE root_session_id IN (${rootIds.map(() => "?").join(", ")})
           AND status != 'archived'
         ORDER BY updated_at DESC, id DESC`
      )
      .bind(...rootIds)
      .all<SessionRow>();
    const sessions = await this.decorateEntriesBatched((sessionResult.results ?? []).map(toEntry));
    const sessionsByRoot = new Map<string, SessionEntry[]>();
    for (const session of sessions) {
      const rootId = session.rootSessionId ?? session.id;
      const treeSessions = sessionsByRoot.get(rootId) ?? [];
      treeSessions.push(session);
      sessionsByRoot.set(rootId, treeSessions);
    }

    const lastRoot = pageRoots.at(-1);
    return {
      trees: pageRoots.map((root) => ({
        rootSessionId: root.root_session_id,
        activityAt: root.activity_at,
        sessions: sessionsByRoot.get(root.root_session_id) ?? [],
      })),
      nextCursor:
        (result.results?.length ?? 0) > limit && lastRoot
          ? { activityAt: lastRoot.activity_at, rootSessionId: lastRoot.root_session_id }
          : null,
    };
  }

  /**
   * Attach repository lists and PR status summaries to the paged
   * entries. The two lookups are independent — each is one grouped query
   * keyed by the same session ids — so they run in parallel and merge onto
   * the entries in a single pass. Sessions without rows are returned without
   * the field: consumers fall back to the scalar repo columns, and PR state
   * never influences session ordering (this only decorates paged rows).
   */
  private async decorateEntries(sessions: SessionEntry[]): Promise<SessionEntry[]> {
    if (sessions.length === 0) return sessions;
    const sessionIds = sessions.map((session) => session.id);

    const [repositoriesBySession, summariesBySession] = await Promise.all([
      this.repositoriesForSessions(sessionIds),
      new SessionPullRequestStore(this.db).summariesForSessions(sessionIds),
    ]);

    return sessions.map((session) => {
      const repositories = repositoriesBySession.get(session.id);
      const pullRequestSummary = summariesBySession.get(session.id);
      return {
        ...session,
        ...(repositories ? { repositories } : {}),
        ...(pullRequestSummary ? { pullRequestSummary } : {}),
      };
    });
  }

  private async decorateEntriesBatched(sessions: SessionEntry[]): Promise<SessionEntry[]> {
    const decorated: SessionEntry[] = [];
    for (let index = 0; index < sessions.length; index += SESSION_DECORATION_BATCH_SIZE) {
      const batch = sessions.slice(index, index + SESSION_DECORATION_BATCH_SIZE);
      decorated.push(...(await this.decorateEntries(batch)));
    }
    return decorated;
  }

  /** Repository lists for the given sessions, in one query. */
  private async repositoriesForSessions(
    sessionIds: readonly string[]
  ): Promise<Map<string, SessionIndexRepository[]>> {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT * FROM session_repositories
         WHERE session_id IN (${placeholders})
         ORDER BY session_id, position`
      )
      .bind(...sessionIds)
      .all<SessionRepositoryRow>();

    const bySession = new Map<string, SessionIndexRepository[]>();
    for (const row of result.results || []) {
      const list = bySession.get(row.session_id) ?? [];
      list.push({
        repoOwner: row.repo_owner,
        repoName: row.repo_name,
        repoId: row.repo_id,
        baseBranch: row.base_branch,
      });
      bySession.set(row.session_id, list);
    }
    return bySession;
  }

  async updateTitle(id: string, title: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .bind(title, Date.now(), id)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  async updateTitleIfNewer(id: string, title: string, updatedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(title, updatedAt, id, updatedAt)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async updateStatus(id: string, status: SessionStatus, updatedAt = Date.now()): Promise<boolean> {
    // Protect against out-of-order async writes by only applying monotonic updated_at values.
    const result = await this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(status, updatedAt, id, updatedAt)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async updateMetrics(
    id: string,
    metrics: {
      totalCost: number;
      activeDurationMs: number;
      messageCount: number;
      prCount: number;
    }
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET total_cost = ?, active_duration_ms = ?, message_count = ?, pr_count = ?
         WHERE id = ?`
      )
      .bind(metrics.totalCost, metrics.activeDurationMs, metrics.messageCount, metrics.prCount, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async touchUpdatedAt(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async delete(id: string): Promise<boolean> {
    // Member rows are removed explicitly for clarity; the FK's ON DELETE
    // CASCADE also covers callers that delete the session row directly.
    const [, result] = await this.db.batch([
      this.db.prepare("DELETE FROM session_repositories WHERE session_id = ?").bind(id),
      this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    ]);

    return (result.meta?.changes ?? 0) > 0;
  }

  /** List children of a parent session, newest first. */
  async listByParent(parentSessionId: string): Promise<SessionEntry[]> {
    const result = await this.db
      .prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC`)
      .bind(parentSessionId)
      .all<SessionRow>();
    return (result.results || []).map(toEntry);
  }

  /** Count active (non-terminal) children for concurrent cap enforcement. */
  async countActiveChildren(parentSessionId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM sessions
         WHERE parent_session_id = ? AND status NOT IN ('completed', 'failed', 'archived', 'cancelled')`
      )
      .bind(parentSessionId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  /** Count total children ever spawned for rate-limit enforcement. */
  async countTotalChildren(parentSessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ?`)
      .bind(parentSessionId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  /** Validate that childId is a direct child of parentId. */
  async isChildOf(childId: string, parentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`SELECT 1 FROM sessions WHERE id = ? AND parent_session_id = ?`)
      .bind(childId, parentId)
      .first();
    return result !== null;
  }

  /** Get a session's stored spawn_depth (single read, no chain walking). */
  async getSpawnDepth(sessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT spawn_depth FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ spawn_depth: number }>();
    return result?.spawn_depth ?? 0;
  }
}
