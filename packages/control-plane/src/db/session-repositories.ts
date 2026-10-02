import { sessionRepositoryRowSchema } from "./session-list-metadata";
import type { SqlDatabase } from "./sql-database";

/** Persisted session membership, independent of mutable environment provenance. */
export class SessionRepositoryStore {
  constructor(private readonly db: SqlDatabase) {}

  async listRepositoryIds(
    sessionId: string
  ): Promise<Array<{ repoOwner: string; repoName: string; repoId: number | null }>> {
    const rows = await this.db
      .prepare("SELECT * FROM session_repositories WHERE session_id = ? ORDER BY position")
      .bind(sessionId)
      .all();
    return rows.results.map((value) => {
      const row = sessionRepositoryRowSchema.parse(value);
      return { repoOwner: row.repo_owner, repoName: row.repo_name, repoId: row.repo_id };
    });
  }
}
