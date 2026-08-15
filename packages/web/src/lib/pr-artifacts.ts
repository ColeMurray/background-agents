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
 * All PR artifacts belonging to the target repository, oldest first —
 * creation order matches PR-number order, including for legacy artifacts
 * whose metadata carries no number. The ownership convention (identity-less
 * legacy metadata belongs to the primary) is the shared
 * prArtifactBelongsToRepo — the same rule the control plane applies.
 */
export function listPrArtifactsForRepo(
  artifacts: readonly Artifact[],
  targetRepo: { repoOwner: string; repoName: string },
  targetIsPrimary: boolean
): Artifact[] {
  return artifacts
    .filter((artifact) => prArtifactMatchesRepo(artifact, targetRepo, targetIsPrimary))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Display states that still accept commits (draft is an open PR). */
const OPEN_DISPLAY_STATES = new Set(["open", "draft"]);

/**
 * The PR a session-level action should target: the most recently created
 * open (or draft) PR, falling back to the most recent PR of any state —
 * sessions can hold several PRs and only open ones are actionable.
 */
export function findLatestOpenPrArtifact(
  artifacts: readonly Artifact[],
  targetRepo?: { repoOwner: string; repoName: string } | null,
  targetIsPrimary = true
): Artifact | undefined {
  const candidates = artifacts
    .filter((artifact) =>
      targetRepo
        ? prArtifactMatchesRepo(artifact, targetRepo, targetIsPrimary)
        : artifact.type === "pr"
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    candidates.find((artifact) => OPEN_DISPLAY_STATES.has(artifact.metadata?.prState ?? "")) ??
    candidates[0]
  );
}
