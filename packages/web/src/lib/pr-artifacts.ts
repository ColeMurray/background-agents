import { prArtifactBelongsToRepo } from "@open-inspect/shared/types/repositories";
import type { Artifact } from "@/types/session";

function prArtifactMatchesRepo(
  artifact: Artifact,
  targetRepo: { repoOwner: string; repoName: string },
  targetIsPrimary: boolean
): boolean {
  if (artifact.type !== "pr") return false;
  const { repoOwner, repoName } = artifact.metadata ?? {};
  return prArtifactBelongsToRepo(
    repoOwner !== undefined && repoName !== undefined ? { repoOwner, repoName } : null,
    targetRepo,
    targetIsPrimary
  );
}

/**
 * Every PR artifact in the session regardless of repository, oldest first —
 * creation order matches PR-number order, including for legacy artifacts
 * whose metadata carries no number.
 */
export function listPrArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  return artifacts
    .filter((artifact) => artifact.type === "pr")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * All PR artifacts belonging to the target repository, oldest first. The
 * ownership convention (identity-less legacy metadata belongs to the primary)
 * is the shared prArtifactBelongsToRepo — the same rule the control plane
 * applies.
 */
export function listPrArtifactsForRepo(
  artifacts: readonly Artifact[],
  targetRepo: { repoOwner: string; repoName: string },
  targetIsPrimary: boolean
): Artifact[] {
  return listPrArtifacts(artifacts).filter((artifact) =>
    prArtifactMatchesRepo(artifact, targetRepo, targetIsPrimary)
  );
}
