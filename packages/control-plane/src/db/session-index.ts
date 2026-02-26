export interface SessionEntry {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  model: string;
  reasoningEffort: string | null;
  baseBranch: string | null;
  status: string;
  parentSessionId?: string | null;
  spawnSource?: "user" | "agent";
  spawnDepth?: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  title: string | null;
  repo_owner: string;
  repo_name: string;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: string;
  parent_session_id: string | null;
  spawn_source: "user" | "agent";
  spawn_depth: number;
  created_at: number;
  updated_at: number;
}

export interface ListSessionsOptions {
  status?: string;
  excludeStatus?: string;
  repoOwner?: string;
  repoName?: string;
  limit?: number;
  offset?: number;
}

export interface ListSessionsResult {
  sessions: SessionEntry[];
  total: number;
  hasMore: boolean;
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
    spawnSource: row.spawn_source,
    spawnDepth: row.spawn_depth,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionIndexStore {
  constructor(private readonly db: D1Database) {}

  async create(session: SessionEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, title, repo_owner, repo_name, model, reasoning_effort, base_branch, status, parent_session_id, spawn_source, spawn_depth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        session.id,
        session.title,
        session.repoOwner.toLowerCase(),
        session.repoName.toLowerCase(),
        session.model,
        session.reasoningEffort,
        session.baseBranch,
        session.status,
        session.parentSessionId ?? null,
        session.spawnSource ?? "user",
        session.spawnDepth ?? 0,
        session.createdAt,
        session.updatedAt
      )
      .run();
  }

  async get(id: string): Promise<SessionEntry | null> {
    const result = await this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(id)
      .first<SessionRow>();

    return result ? toEntry(result) : null;
  }

  async list(options: ListSessionsOptions = {}): Promise<ListSessionsResult> {
    const { status, excludeStatus, repoOwner, repoName, limit = 50, offset = 0 } = options;

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

    if (repoOwner) {
      conditions.push("repo_owner = ?");
      params.push(repoOwner.toLowerCase());
    }

    if (repoName) {
      conditions.push("repo_name = ?");
      params.push(repoName.toLowerCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM sessions ${where}`)
      .bind(...params)
      .first<{ count: number }>();

    const total = countResult?.count ?? 0;

    // Get paginated results
    const result = await this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<SessionRow>();

    const sessions = (result.results || []).map(toEntry);

    return {
      sessions,
      total,
      hasMore: offset + sessions.length < total,
    };
  }

  async updateStatus(id: string, status: string, updatedAt = Date.now()): Promise<boolean> {
    // Protect against out-of-order async writes by only applying monotonic updated_at values.
    const result = await this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(status, updatedAt, id, updatedAt)
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
    const result = await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();

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
