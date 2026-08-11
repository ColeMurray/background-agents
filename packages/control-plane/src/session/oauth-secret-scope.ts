import type { OAuthSecretScope } from "../auth/scoped-oauth-secrets";
import type { SessionRow } from "./types";

/** Maps a session target to its provider OAuth secret scope. */
export async function resolveSessionOAuthSecretScope(
  session: SessionRow,
  ensureRepoId: (session: SessionRow) => Promise<number>
): Promise<OAuthSecretScope | null> {
  if (session.environment_id) {
    return { kind: "environment", environmentId: session.environment_id };
  }
  if (session.repo_owner && session.repo_name) {
    return {
      kind: "repo",
      repoId: await ensureRepoId(session),
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
    };
  }
  return null;
}
