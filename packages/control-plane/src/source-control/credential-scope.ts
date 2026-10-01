import { z } from "zod";
import { SourceControlProviderError } from "./errors";

/**
 * Per-call scope for deployment-level credentials; providers are shared across sessions.
 * GitHub honors this scope when minting installation tokens. GitLab uses a
 * deployment-wide PAT and does not narrow its credentials by scope.
 * GitHub refuses an empty repository scope rather than granting installation-wide access.
 */
export type CredentialScope = { kind: "all" } | { kind: "repositories"; repositoryIds: number[] };

export const MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS = 500;

/** Canonical repository-only scope, including the GitHub installation-token limit. */
export function repositoryCredentialScope(
  repositoryIds: number[]
): Extract<CredentialScope, { kind: "repositories" }> {
  if (repositoryIds.length === 0) {
    throw new SourceControlProviderError(
      "Cannot generate credentials: no repositories in scope",
      "permanent"
    );
  }
  if (!z.array(z.number().int().positive()).safeParse(repositoryIds).success) {
    throw new SourceControlProviderError(
      "Cannot generate credentials: invalid repository ids",
      "permanent"
    );
  }
  const ids = [...new Set(repositoryIds)].sort((a, b) => a - b);
  if (ids.length > MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS) {
    throw new SourceControlProviderError(
      `Cannot generate credentials: scope exceeds ${MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS} repositories`,
      "permanent"
    );
  }
  return { kind: "repositories", repositoryIds: ids };
}
