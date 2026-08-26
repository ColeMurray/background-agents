import type { SourceControlProvider } from "../source-control";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionRow } from "./types";

/**
 * Resolve the session's primary repo id, looking it up via the SCM provider
 * and persisting it for legacy rows that predate `repo_id`. The provider is
 * taken as a thunk so rows that already carry an id never construct it —
 * `createSourceControlProviderFromEnv` throws on misconfigured SCM env.
 */
export async function resolveSessionRepoId(
  session: SessionRow,
  sessionCoreRepository: SessionCoreRepository,
  getSourceControlProvider: () => SourceControlProvider
): Promise<number> {
  if (session.repo_id) {
    return session.repo_id;
  }
  if (!session.repo_owner || !session.repo_name) {
    throw new Error("Session has no repository context");
  }

  const result = await getSourceControlProvider().checkRepositoryAccess({
    owner: session.repo_owner,
    name: session.repo_name,
  });
  if (!result) {
    throw new Error("Repository is not accessible for the configured SCM provider");
  }

  sessionCoreRepository.updateSessionRepoId(result.repoId);
  return result.repoId;
}
