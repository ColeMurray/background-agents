import { z } from "zod";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { sessionRepositoryRowSchema } from "./session-list-metadata";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/** D1 reads and atomic writes for session scope changes. */
export class SessionScopeStore {
  constructor(private readonly db: SqlDatabase) {}

  async listDescendantIds(id: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM sessions WHERE parent_session_id = ?
           UNION
           SELECT child.id FROM sessions child
           JOIN descendants ON child.parent_session_id = descendants.id
         ) SELECT id FROM descendants`
      )
      .bind(id)
      .all();
    return z
      .array(z.object({ id: z.string() }))
      .parse(rows.results)
      .map((row) => row.id);
  }

  async listRepositoryIds(
    id: string
  ): Promise<Array<{ repoOwner: string; repoName: string; repoId: number | null }>> {
    const rows = await this.db
      .prepare("SELECT * FROM session_repositories WHERE session_id = ? ORDER BY position")
      .bind(id)
      .all();
    const repositories = rows.results.map((row) => {
      const parsed = sessionRepositoryRowSchema.parse(row);
      return { repoOwner: parsed.repo_owner, repoName: parsed.repo_name, repoId: parsed.repo_id };
    });
    if (repositories.length) return repositories;
    const row = await this.db
      .prepare("SELECT repo_owner, repo_name FROM sessions WHERE id = ?")
      .bind(id)
      .first();
    const session = row
      ? z.object({ repo_owner: z.string().nullable(), repo_name: z.string().nullable() }).parse(row)
      : null;
    return session?.repo_owner && session.repo_name
      ? [{ repoOwner: session.repo_owner, repoName: session.repo_name, repoId: null }]
      : [];
  }

  async updateVisibility(
    ids: string[],
    visibility: SessionVisibility,
    audits: SqlStatement[] = []
  ): Promise<void> {
    if (!ids.length) return;
    await this.db.batch([
      ...ids.map((id) =>
        this.db.prepare("UPDATE sessions SET visibility = ? WHERE id = ?").bind(visibility, id)
      ),
      ...audits,
    ]);
  }

  async updateOwnerTeam(
    ids: string[],
    teamId: string | null,
    audits: SqlStatement[] = [],
    beforeStatements: SqlStatement[] = [],
    joiningUserId?: string
  ): Promise<boolean> {
    if (!ids.length) return false;
    const activeTeam = teamId
      ? " AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND archived_at IS NULL)"
      : "";
    const membership = joiningUserId
      ? " AND EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ?)"
      : "";
    const results = await this.db.batch([
      ...beforeStatements,
      ...ids.map((id) =>
        this.db
          .prepare(
            `UPDATE sessions SET owner_team_id = ?, visibility = CASE WHEN ? IS NULL AND visibility = 'team' THEN 'workspace' ELSE visibility END WHERE id = ?${activeTeam}${membership}`
          )
          .bind(
            teamId,
            teamId,
            id,
            ...(teamId ? [teamId] : []),
            ...(joiningUserId ? [teamId, joiningUserId] : [])
          )
      ),
      ...audits,
    ]);
    return (results[beforeStatements.length]?.meta.changes ?? 0) > 0;
  }
}
