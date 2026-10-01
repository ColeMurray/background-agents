import { z } from "zod";
import { EnvironmentStore } from "../db/environments";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import type { CredentialScope } from "../source-control/credential-scope";
import { resolveTeamTokenScope } from "../source-control/team-scope";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import type { ImageBuildScope } from "./model";
import type { ResolvedImageBuildTarget } from "./scope";

/** Token access follows environment ownership or the union of teams granted a repo. */
export async function resolveImageBuildTokenScope(
  db: SqlDatabase,
  scope: ImageBuildScope,
  target: ResolvedImageBuildTarget
): Promise<CredentialScope> {
  if (scope.kind !== target.kind) {
    throw new ImageBuildPlanningError("Image build scope and target kinds do not match");
  }

  switch (target.kind) {
    case "environment": {
      const environment = await new EnvironmentStore(db).getById(scope.id);
      if (!environment) throw new ImageBuildScopeNotFoundError(scope.kind, scope.id);
      return resolveTeamTokenScope(db, environment.owner_team_id);
    }
    case "repo": {
      const teams = await new TeamStore(db).list({ includeArchived: true });
      const store = new TeamRepositoryGrantStore(db);
      const grantsByTeam = await Promise.all(teams.map((team) => store.listForTeam(team.id)));
      if (
        grantsByTeam.some((grants) => grants.some((grant) => grant.grant_kind === "installation"))
      ) {
        return { kind: "all" };
      }

      const repositoryIds = grantsByTeam
        .filter((grants) =>
          grants.some(
            (grant) => grant.grant_kind === "repository" && grant.repo_external_id === target.repoId
          )
        )
        .flatMap((grants) =>
          grants.map((grant) => z.number().int().positive().parse(grant.repo_external_id))
        );
      return {
        kind: "repositories",
        repositoryIds: [...new Set(repositoryIds)].sort((a, b) => a - b),
      };
    }
  }
}
