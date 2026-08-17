import { prArtifactBelongsToRepo } from "@open-inspect/shared/types/repositories";
import type { PullRequestLifecycleState } from "@open-inspect/shared/types/artifacts";
import { normalizeBranchName } from "../source-control/branch-resolution";
import { parsePullRequestArtifactMetadata } from "./pull-request-snapshot";
import type { RepoIdentity } from "./repository-target";
import type { ArtifactRow } from "./types";

/**
 * Repo identity from a PR artifact's metadata. Null when the metadata carries
 * no identity — artifacts written before multi-repo support, which by
 * construction belong to the session's primary repository. The canonical
 * home of that convention: both the duplicate-PR guard and the per-repo
 * artifact find go through here.
 */
function parsePrArtifactRepo(metadata: string | null): RepoIdentity | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { repoOwner, repoName } = parsed as { repoOwner?: unknown; repoName?: unknown };
    if (typeof repoOwner !== "string" || typeof repoName !== "string") return null;
    return { repoOwner, repoName };
  } catch {
    return null;
  }
}

/**
 * Find a PR artifact belonging to the target repo. The ownership convention
 * is the shared prArtifactBelongsToRepo (the same rule the web sidebar and
 * action bar apply); this find works on ArtifactRow's native JSON-string
 * metadata directly.
 */
export function findPrArtifactForRepo(
  artifacts: ArtifactRow[],
  targetRepo: RepoIdentity,
  isPrimary: boolean
): ArtifactRow | undefined {
  return artifacts.find(
    (artifact) =>
      artifact.type === "pr" &&
      prArtifactBelongsToRepo(parsePrArtifactRepo(artifact.metadata), targetRepo, isPrimary)
  );
}

const LIFECYCLE_STATES: readonly PullRequestLifecycleState[] = ["open", "closed", "merged"];

/** A repo's PR artifact matched by head branch, with the metadata facts the
 * duplicate decision needs. Null facts mean the (legacy) metadata lacks them. */
export interface PrArtifactHeadMatch {
  artifact: ArtifactRow;
  prNumber: number | null;
  lifecycleState: PullRequestLifecycleState | null;
  isDraft: boolean;
  baseBranch: string | null;
  repositoryExternalId: string | null;
}

/**
 * PR artifacts belonging to the target repo whose head branch matches,
 * newest-updated first. Metadata without a `head` (written before per-branch
 * PRs) belongs to the generated session branch — the only head PRs could be
 * created from at the time.
 */
export function listPrArtifactsForHead(
  artifacts: ArtifactRow[],
  targetRepo: RepoIdentity,
  isPrimary: boolean,
  branches: { headBranch: string; generatedHeadBranch: string }
): PrArtifactHeadMatch[] {
  const normalizedHead = normalizeBranchName(branches.headBranch);
  return artifacts
    .filter(
      (artifact) =>
        artifact.type === "pr" &&
        prArtifactBelongsToRepo(parsePrArtifactRepo(artifact.metadata), targetRepo, isPrimary)
    )
    .map((artifact) => {
      const metadata = parsePullRequestArtifactMetadata(artifact.metadata);
      const head = typeof metadata.head === "string" ? metadata.head : branches.generatedHeadBranch;
      if (normalizeBranchName(head) !== normalizedHead) return null;
      return {
        artifact,
        prNumber: typeof metadata.number === "number" ? metadata.number : null,
        lifecycleState: LIFECYCLE_STATES.find((state) => state === metadata.lifecycleState) ?? null,
        isDraft: metadata.isDraft === true,
        baseBranch: typeof metadata.base === "string" ? metadata.base : null,
        repositoryExternalId:
          typeof metadata.repositoryExternalId === "string" ? metadata.repositoryExternalId : null,
      };
    })
    .filter((match): match is PrArtifactHeadMatch => match !== null)
    .sort((a, b) => b.artifact.updated_at - a.artifact.updated_at);
}
