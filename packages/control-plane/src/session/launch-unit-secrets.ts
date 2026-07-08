import type { SecretSource } from "../db/secrets-validation";
import type { SessionRepositoryEntry } from "./repository-target";

export interface LaunchUnitSecretSourcesInput {
  /**
   * The launch unit's environment id, or null for repo-launched sessions. PR-9
   * passes `session.environment_id`; until migration 0033 adds the column this
   * is always null and every session is repo-launched.
   */
  environmentId: number | null;
  globalSecrets: Record<string, string>;
  /** Session member repositories in position order (index 0 = primary). */
  members: SessionRepositoryEntry[];
  /** Decrypt a member's secrets, or {} when it has no resolvable repo id. */
  loadMemberSecrets: (member: SessionRepositoryEntry) => Promise<Record<string, string>>;
}

/**
 * Build the ordered secret sources for a session's launch unit, lowest
 * precedence first (design §6.4). Global is always the base; environment-
 * launched sessions add environment secrets only (member repo secrets never
 * inherit — launch-unit scoping, §6.4/§7.4), while repo-launched and ad-hoc
 * sessions fold their member repos with the primary (position 0) merged last so
 * it wins collisions. A single-repo session degenerates to today's global+repo.
 *
 * This owns the launch-unit sourcing policy so the DO only loads sources, merges
 * (mergeSecretSources), and audits the cap. The environment source is filled in
 * by PR-9 with the environment secrets store; until then environmentId is always
 * null and this is always the repo path.
 */
export async function buildLaunchUnitSecretSources(
  input: LaunchUnitSecretSourcesInput
): Promise<SecretSource[]> {
  const sources: SecretSource[] = [{ label: "global", secrets: input.globalSecrets }];

  if (input.environmentId !== null) {
    // PR-9: sources.push({ label: "environment", secrets: <environment secrets> })
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
