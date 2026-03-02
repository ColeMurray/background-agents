/**
 * Agent defaults store: per-user, per-repo default OpenCode agent.
 */

export class AgentDefaultsStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get the default agent for a user and repo, or null if not set.
   */
  async get(userId: string, repoOwner: string, repoName: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT default_agent FROM agent_defaults
         WHERE user_id = ? AND repo_owner = ? AND repo_name = ?`
      )
      .bind(userId, repoOwner.toLowerCase(), repoName.toLowerCase())
      .first<{ default_agent: string | null }>();

    return row?.default_agent ?? null;
  }

  /**
   * Get all default agents for a user (for settings UI).
   */
  async getAllForUser(
    userId: string
  ): Promise<{ repoOwner: string; repoName: string; defaultAgent: string | null }[]> {
    const { results } = await this.db
      .prepare(`SELECT repo_owner, repo_name, default_agent FROM agent_defaults WHERE user_id = ?`)
      .bind(userId)
      .all<{ repo_owner: string; repo_name: string; default_agent: string | null }>();

    return (results ?? []).map((r) => ({
      repoOwner: r.repo_owner,
      repoName: r.repo_name,
      defaultAgent: r.default_agent,
    }));
  }

  /**
   * Set the default agent for a user and repo. Pass null/empty to clear.
   */
  async set(
    userId: string,
    repoOwner: string,
    repoName: string,
    defaultAgent: string | null
  ): Promise<void> {
    const now = Date.now();
    const owner = repoOwner.toLowerCase();
    const name = repoName.toLowerCase();
    const value = defaultAgent?.trim() || null;

    await this.db
      .prepare(
        `INSERT INTO agent_defaults (user_id, repo_owner, repo_name, default_agent, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, repo_owner, repo_name) DO UPDATE SET
           default_agent = excluded.default_agent,
           updated_at = excluded.updated_at`
      )
      .bind(userId, owner, name, value, now)
      .run();
  }
}
