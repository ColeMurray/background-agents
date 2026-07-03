import type { NewAutomationRepository } from "../db/automation-store";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";

/** A repository resolved for one firing: access checked, branch defaulted. */
export interface ResolvedAutomationRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

/**
 * Per-repository resolution outcome. `repository` is null when the SCM
 * provider rejected (or errored on) the repo; `error` then carries the child
 * run's failure_reason. `requested` preserves the selection row so a failed
 * child still gets a repository snapshot.
 */
export interface AutomationRepositoryResolution {
  requested: NewAutomationRepository;
  repository: ResolvedAutomationRepository | null;
  error: string | null;
}

/**
 * Resolve an automation's selected repositories concurrently at firing time.
 * One inaccessible repository never blocks its siblings — it resolves to an
 * error entry and the caller pre-fails that child run.
 */
export async function resolveAutomationRepositories(
  env: Env,
  repositories: NewAutomationRepository[],
  sourceControlProvider?: SourceControlProvider
): Promise<AutomationRepositoryResolution[]> {
  if (repositories.length === 0) return [];

  const provider = sourceControlProvider ?? createSourceControlProviderFromEnv(env);

  return Promise.all(
    repositories.map(async (requested): Promise<AutomationRepositoryResolution> => {
      try {
        const access = await provider.checkRepositoryAccess({
          owner: requested.repo_owner,
          name: requested.repo_name,
        });
        if (!access) {
          return {
            requested,
            repository: null,
            error: "Repository is not accessible for the configured SCM provider",
          };
        }
        return {
          requested,
          repository: {
            repoOwner: access.repoOwner,
            repoName: access.repoName,
            repoId: access.repoId,
            baseBranch: requested.base_branch?.trim() || access.defaultBranch || "main",
          },
          error: null,
        };
      } catch (e) {
        return {
          requested,
          repository: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })
  );
}
