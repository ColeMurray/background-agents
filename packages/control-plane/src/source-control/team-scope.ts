import { z } from "zod";
import type { TokenScope } from "../auth/github-app";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";

/** Workspace sessions retain installation access; team sessions use only their grants. */
export async function resolveTeamTokenScope(
  db: SqlDatabase,
  teamId: string | null
): Promise<TokenScope> {
  if (teamId === null) return { kind: "all" };
  const grants = await new TeamRepositoryGrantStore(db).listForTeam(teamId);
  if (grants.some((grant) => grant.grant_kind === "installation")) return { kind: "all" };
  const repositoryIds = grants.map((grant) =>
    z.number().int().positive().parse(grant.repo_external_id)
  );
  return { kind: "repositories", repositoryIds: [...new Set(repositoryIds)].sort((a, b) => a - b) };
}
