export interface SessionEntry {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  model: string;
  reasoningEffort: string | null;
  branch: string | null;
  status: string;
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
  branch: string | null;
  status: string;
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
    branch: row.branch,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionIndexStore {
  constructor(private readonly db: D1Database) {}

  async create(session: SessionEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, title, repo_owner, repo_name, model, reasoning_effort, branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        session.id,
        session.title,
        session.repoOwner.toLowerCase(),
        session.repoName.toLowerCase(),
        session.model,
        session.reasoningEffort,
        session.branch,
        session.status,
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

  async updateStatus(id: string, status: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, Date.now(), id)
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
}
