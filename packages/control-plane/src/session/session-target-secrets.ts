import type { OAuthSecretScope } from "../db/scoped-oauth-secrets";
import type { SecretSource } from "../db/secrets-validation";
import type { SessionRepositoryEntry } from "./repository-target";
import type { SessionRow } from "./types";

/** Maps a session target to the secret scope that owns its provider OAuth credentials. */
export async function resolveSessionOAuthSecretScope(
  session: SessionRow,
  ensureRepoId: (session: SessionRow) => Promise<number>
): Promise<OAuthSecretScope | null> {
  const { repo_owner: repoOwner, repo_name: repoName } = session;
  const hasEmptyRepositoryIdentifier =
    (repoOwner !== null && repoOwner.trim().length === 0) ||
    (repoName !== null && repoName.trim().length === 0);
  if (hasEmptyRepositoryIdentifier || (repoOwner === null) !== (repoName === null)) {
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

export interface SessionTargetSecretSourcesInput {
  /**
   * The session target's environment id (`session.environment_id`), or null for
   * repo-launched/ad-hoc sessions. When set, secrets come from global +
   * environment only — the session's member repos never contribute (session-target
   * scoping, §6.4/§7.4).
   */
  environmentId: string | null;
  globalSecrets: Record<string, string>;
  /** Session member repositories in position order (index 0 = primary). */
  members: SessionRepositoryEntry[];
  /** Decrypt a member's secrets, or {} when it has no resolvable repo id. */
  loadMemberSecrets: (member: SessionRepositoryEntry) => Promise<Record<string, string>>;
  /**
   * Decrypt a launch environment's secrets. Called only for environment-launched
   * sessions (when environmentId is set), so repo-launched sessions never touch
   * the environment store.
   */
  loadEnvironmentSecrets: (environmentId: string) => Promise<Record<string, string>>;
}

/**
 * Build the ordered secret sources for a session target, lowest
 * precedence first (design §6.4). Global is always the base; environment-
 * launched sessions add environment secrets only (member repo secrets never
 * inherit — session-target scoping, §6.4/§7.4), while repo-launched and ad-hoc
 * sessions fold their member repos with the primary (position 0) merged last so
 * it wins collisions. A single-repo session degenerates to today's global+repo.
 *
 * This owns the session-target sourcing policy so the DO only loads sources, merges
 * (mergeSecretSources), and audits the cap.
 */
export async function buildSessionTargetSecretSources(
  input: SessionTargetSecretSourcesInput
): Promise<SecretSource[]> {
  const sources: SecretSource[] = [{ label: "global", secrets: input.globalSecrets }];

  if (input.environmentId !== null) {
    const environmentSecrets = await input.loadEnvironmentSecrets(input.environmentId);
    if (Object.keys(environmentSecrets).length > 0) {
      sources.push({ label: "environment", secrets: environmentSecrets });
    }
    return sources;
  }

  // Reverse position order: the primary (position 0) merges last and wins.
  for (const member of [...input.members].reverse()) {
    const secrets = await input.loadMemberSecrets(member);
    if (Object.keys(secrets).length > 0) {
      sources.push({ label: `${member.repoOwner}/${member.repoName}`, secrets });
    }
  }
  return sources;
}
