/**
 * Spawn-time prebuilt-image selection.
 *
 * A session boots from its scope's prebuilt image iff the latest ready image
 * on the active provider passes the runtime-compatibility floor and its
 * repositories fingerprint equals the fingerprint of the session's OWN
 * repository snapshot — not the scope's current repositories, so an entity
 * edited after the session was created can never hand the session a
 * mismatched image. For a repo scope (one-element set built on the default
 * branch) the fingerprint check reproduces the old base_branch filter: a
 * non-default-branch session computes a different fingerprint and misses. A
 * miss on any condition falls back to the base image; sessions are never
 * blocked on builds.
 *
 * Pure decision logic in the decisions.ts style: the lifecycle manager owns
 * the lookup call, logging, and fallback plumbing.
 */

import {
  computeRepositoriesFingerprint,
  type FingerprintRepositoryInput,
} from "../../image-builds/fingerprint";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  parseRuntimeVersionNumber,
  type ImageBuildScope,
} from "../../image-builds/model";

/**
 * The image-build row fields spawn selection reads. Mirrors the
 * `image_builds` columns (db/image-builds.ts ImageBuildRow); the Durable
 * Object binds the lookup to the store.
 */
export interface ImageBuildSpawnRow {
  id: string;
  provider_image_id: string | null;
  repositories_fingerprint: string;
  repository_shas: string;
  runtime_version: string;
}

/**
 * Provider-scoped lookup interface for prebuilt images, bound by the Durable
 * Object.
 */
export interface ImageBuildLookup {
  /** Latest ready image for the scope on the active provider, enablement-gated. */
  getLatestReady(scope: ImageBuildScope): Promise<ImageBuildSpawnRow | null>;
  /**
   * Fail a ready image whose provider artifact could not be restored, so the
   * rebuild cron sees no ready image and rebuilds it.
   */
  markRestoreFailed(imageBuildId: string, error: string): Promise<boolean>;
}

/** A matched image, reduced to what the spawn config needs. */
export interface SelectedImageBuild {
  imageBuildId: string;
  providerImageId: string;
  /**
   * The primary repository's baked SHA — the scalar prebuiltImageSha mirror
   * (repository_shas is position-ordered, primary first). Null when the
   * provenance document is missing or unparseable; the SHA is informational
   * (boot logging), so a null must not fail the match.
   */
  primaryBaseSha: string | null;
  runtimeVersion: string;
}

export type ImageBuildMissReason =
  | "no_ready_image"
  | "missing_artifact"
  | "runtime_below_floor"
  | "fingerprint_mismatch";

export type ImageBuildSelectionResult =
  | { outcome: "selected"; image: SelectedImageBuild }
  | { outcome: "miss"; reason: ImageBuildMissReason; imageBuildId?: string };

/**
 * Evaluate the latest ready image (or its absence) against the session's own
 * repository snapshot. Checks run cheapest-first; the floor fails closed on an
 * unparseable runtime version (an unversioned image must never boot a
 * multi-repo workspace).
 */
export async function evaluateImageBuildForSpawn(
  image: ImageBuildSpawnRow | null,
  sessionRepositories: FingerprintRepositoryInput[]
): Promise<ImageBuildSelectionResult> {
  if (!image) {
    return { outcome: "miss", reason: "no_ready_image" };
  }
  if (!image.provider_image_id) {
    // Ready rows always record their artifact at mark-ready time; defensive
    // against direct store writes.
    return { outcome: "miss", reason: "missing_artifact", imageBuildId: image.id };
  }

  const runtimeVersion = parseRuntimeVersionNumber(image.runtime_version);
  if (runtimeVersion === null || runtimeVersion < MIN_COMPATIBLE_RUNTIME_VERSION) {
    return { outcome: "miss", reason: "runtime_below_floor", imageBuildId: image.id };
  }

  const sessionFingerprint = await computeRepositoriesFingerprint(sessionRepositories);
  if (image.repositories_fingerprint !== sessionFingerprint) {
    return { outcome: "miss", reason: "fingerprint_mismatch", imageBuildId: image.id };
  }

  return {
    outcome: "selected",
    image: {
      imageBuildId: image.id,
      providerImageId: image.provider_image_id,
      primaryBaseSha: parsePrimaryBaseSha(image.repository_shas),
      runtimeVersion: image.runtime_version,
    },
  };
}

function parsePrimaryBaseSha(repositoryShas: string): string | null {
  try {
    const parsed: unknown = JSON.parse(repositoryShas);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const primary: unknown = parsed[0];
    if (typeof primary !== "object" || primary === null) return null;
    const baseSha = (primary as { baseSha?: unknown }).baseSha;
    return typeof baseSha === "string" && baseSha.length > 0 ? baseSha : null;
  } catch {
    return null;
  }
}
