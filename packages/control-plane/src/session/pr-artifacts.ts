import { findPrArtifactForRepo as findPrArtifactForRepoShared } from "@open-inspect/shared";
import type { RepoIdentity } from "./repository-target";
import type { ArtifactRow } from "./types";

/**
 * Repo identity from a PR artifact's metadata. Null when the metadata carries
 * no identity — artifacts written before multi-repo support, which by
 * construction belong to the session's primary repository. The canonical
 * home of that convention: both the duplicate-PR guard and the per-repo
 * prUrl projection go through here.
 */
export function parsePrArtifactRepo(metadata: string | null): RepoIdentity | null {
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
 * Find a PR artifact belonging to the target repo. The find-over-convention
 * step is the shared findPrArtifactForRepo (also used by the web sidebar and
 * action bar); this adapter only parses the identity out of ArtifactRow's
 * JSON metadata.
 */
export function findPrArtifactForRepo(
  artifacts: ArtifactRow[],
  targetRepo: RepoIdentity,
  isPrimary: boolean
): ArtifactRow | undefined {
  return findPrArtifactForRepoShared(
    artifacts.map((artifact) => ({
      artifact,
      type: artifact.type,
      metadata: parsePrArtifactRepo(artifact.metadata),
    })),
    targetRepo,
    isPrimary
  )?.artifact;
}
