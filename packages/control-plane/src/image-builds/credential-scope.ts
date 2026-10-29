import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { EnvironmentStore } from "../db/environments";
import type { SqlDatabase } from "../db/sql-database";
import {
  repositoryCredentialScope,
  type CredentialScope,
} from "../source-control/credential-scope";
import { resolveRepositoryCredentialScope } from "../source-control/repository-scope";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import type { ImageBuildScope } from "./model";
import { repositoryIdentityKey } from "./provenance";
import type { ResolvedImageBuildTarget } from "./scope";

/** Credentials cover only planned repositories, intersected with the environment owner's grants. */
export async function resolveImageBuildTokenScope(
  db: SqlDatabase,
  scope: ImageBuildScope,
  target: ResolvedImageBuildTarget,
  loadCatalog: () => Promise<InstallationRepository[]>
): Promise<CredentialScope> {
  if (scope.kind !== target.kind) {
    throw new ImageBuildPlanningError("Image build scope and target kinds do not match");
  }

  switch (target.kind) {
    case "environment": {
      const store = new EnvironmentStore(db);
      const environment = await store.getById(scope.id);
      if (!environment) throw new ImageBuildScopeNotFoundError(scope.kind, scope.id);
      const rows = await store.getRepositoriesForEnvironment(scope.id);
      const repositories = rows.map((row) => ({
        repoOwner: row.repo_owner,
        repoName: row.repo_name,
        repoId: row.repo_id,
      }));
      const currentIdentities = repositories.map(repositoryIdentityKey).sort();
      const plannedIdentities = target.repositories.map(repositoryIdentityKey).sort();
      // An edit after target resolution must not put unplanned repositories in the token.
      if (
        currentIdentities.length !== plannedIdentities.length ||
        currentIdentities.some((identity, index) => identity !== plannedIdentities[index])
      ) {
        throw new ImageBuildPlanningError(`Environment repositories changed: ${scope.id}`);
      }
      return await resolveRepositoryCredentialScope(
        db,
        repositories,
        environment.owner_team_id,
        loadCatalog
      );
    }
    case "repo": {
      if (target.repositories.length !== 1) {
        throw new ImageBuildPlanningError("Repository image build must contain one repository");
      }
      return repositoryCredentialScope([target.repoId]);
    }
  }
}
