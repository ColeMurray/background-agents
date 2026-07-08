import { repoIdentityEquals, type RepoIdentity } from "./repository-target";
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
 * Find a PR artifact belonging to the target repo. Identity-less metadata
 * matches only when the target is the primary.
 */
export function findPrArtifactForRepo(
  artifacts: ArtifactRow[],
  targetRepo: RepoIdentity,
  isPrimary: boolean
): ArtifactRow | undefined {
  return artifacts.find((artifact) => {
    if (artifact.type !== "pr") return false;
    const artifactRepo = parsePrArtifactRepo(artifact.metadata);
    if (!artifactRepo) return isPrimary;
    return repoIdentityEquals(artifactRepo, targetRepo);
  });
}
