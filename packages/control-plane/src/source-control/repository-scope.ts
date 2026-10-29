import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import type { SqlDatabase } from "../db/sql-database";
import { coveredRepositoryIds, TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { repositoryCredentialScope, type CredentialScope } from "./credential-scope";
import { SourceControlProviderError } from "./errors";

/** Resolve only the supplied repositories, intersecting current team grants when owned. */
export async function resolveRepositoryCredentialScope(
  db: SqlDatabase,
  repositories: readonly { repoOwner: string; repoName: string; repoId: number | null }[],
  ownerTeamId: string | null,
  loadInstallationRepositories: () => Promise<InstallationRepository[]>
): Promise<CredentialScope> {
  const catalog = repositories.some((repository) => repository.repoId === null)
    ? await loadInstallationRepositories()
    : [];
  const candidateIds = [
    ...new Set(
      repositories.map((repository) => {
        const repoId =
          repository.repoId ??
          catalog.find(
            (entry) =>
              entry.owner.toLowerCase() === repository.repoOwner.toLowerCase() &&
              entry.name.toLowerCase() === repository.repoName.toLowerCase()
          )?.id;
        if (repoId === undefined || !Number.isSafeInteger(repoId) || repoId <= 0) {
          throw new SourceControlProviderError(
            `Cannot resolve credential scope: repository id unavailable or invalid for ${repository.repoOwner}/${repository.repoName}`,
            "permanent"
          );
        }
        return repoId;
      })
    ),
  ];

  if (ownerTeamId !== null && candidateIds.length > 0) {
    const grants = await new TeamRepositoryGrantStore(db).listForTeam(ownerTeamId);
    return repositoryCredentialScope(coveredRepositoryIds(grants, candidateIds));
  }
  return repositoryCredentialScope(candidateIds);
}
