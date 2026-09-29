import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

const grantSchema = z.object({
  grant_kind: z.enum(["installation", "repository"]),
  repo_external_id: z.number().nullable(),
});

export class TeamRepositoryGrantStore {
  constructor(private readonly db: SqlDatabase) {}

  async listForTeam(teamId: string) {
    const rows = await this.db
      .prepare("SELECT grant_kind, repo_external_id FROM team_repository_grants WHERE team_id = ?")
      .bind(teamId)
      .all();
    return z.array(grantSchema).parse(rows.results);
  }

  async covers(teamId: string, repoIds: readonly (number | null)[]): Promise<boolean> {
    if (repoIds.length === 0) return true;
    const grants = await this.listForTeam(teamId);
    if (grants.some((grant) => grant.grant_kind === "installation")) return true;
    const allowed = new Set(grants.map((grant) => grant.repo_external_id));
    return repoIds.every((id) => id !== null && allowed.has(id));
  }
}
