import { prArtifactBelongsToRepo } from "@open-inspect/shared";
import type { Artifact } from "@/types/session";

/**
 * Find the PR artifact belonging to the target repository. The ownership
 * convention (identity-less legacy metadata belongs to the primary) is the
 * shared prArtifactBelongsToRepo — the same rule the control plane applies.
 */
export function findPrArtifactForRepo(
  artifacts: readonly Artifact[],
  targetRepo: { repoOwner: string; repoName: string },
  targetIsPrimary: boolean
): Artifact | undefined {
  return artifacts.find((artifact) => {
    if (artifact.type !== "pr") return false;
    const { repoOwner, repoName } = artifact.metadata ?? {};
    return prArtifactBelongsToRepo(
      repoOwner !== undefined && repoName !== undefined ? { repoOwner, repoName } : null,
      targetRepo,
      targetIsPrimary
    );
  });
}
