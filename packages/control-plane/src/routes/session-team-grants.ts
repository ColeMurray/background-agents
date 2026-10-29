import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { SqlDatabase } from "../db/sql-database";

export interface GrantRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
}

export async function missingTeamRepository(
  db: SqlDatabase,
  teamId: string,
  repositories: readonly GrantRepository[]
): Promise<GrantRepository | null> {
  const store = new TeamRepositoryGrantStore(db);
  if (
    await store.covers(
      teamId,
      repositories.map((repo) => repo.repoId)
    )
  )
    return null;
  const grants = await store.listForTeam(teamId);
  const grantedIds = new Set(grants.map((grant) => grant.repo_external_id));
  return repositories.find((repo) => repo.repoId === null || !grantedIds.has(repo.repoId)) ?? null;
}
