import type { OAuthSecretScope } from "../auth/scoped-oauth-secrets";
import type { SessionRow } from "./types";

/** Maps a session target to its provider OAuth secret scope. */
export async function resolveSessionOAuthSecretScope(
  session: SessionRow,
  ensureRepoId: (session: SessionRow) => Promise<number>
): Promise<OAuthSecretScope | null> {
  const { repo_owner: repoOwner, repo_name: repoName } = session;
  const hasRepoOwner = repoOwner !== null;
  const hasRepoName = repoName !== null;
  if (hasRepoOwner !== hasRepoName) {
    throw new Error("Session has incomplete repository context");
  }

  if (session.environment_id) {
    return { kind: "environment", environmentId: session.environment_id };
  }
  if (repoOwner !== null && repoName !== null) {
    return {
      kind: "repo",
      repoId: await ensureRepoId(session),
      repoOwner,
      repoName,
    };
  }
  return null;
}
