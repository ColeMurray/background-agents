/**
 * Spawn-time environment-image selection (design §7.3 "Spawn-time matching").
 *
 * An environment session boots from its environment image iff the latest
 * ready image on the active provider passes the runtime-compatibility floor
 * and its repositories fingerprint equals the fingerprint of the session's
 * OWN repository snapshot — not the environment's current repositories, so an
 * environment edited after the session was created can never hand the session
 * a mismatched image. A miss on any condition falls back to the base image;
 * sessions are never blocked on builds.
 *
 * Pure decision logic in the decisions.ts style: the lifecycle manager owns
 * the lookup call, logging, and fallback plumbing.
 */

import {
  computeRepositoriesFingerprint,
  type FingerprintRepositoryInput,
} from "../../environment-images/fingerprint";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  parseRuntimeVersionNumber,
} from "../../environment-images/model";

/**
 * The environment-image row fields spawn selection reads. Mirrors the
 * `environment_images` columns (db/environment-images.ts EnvironmentImage);
 * the Durable Object binds the lookup to the store.
 */
export interface EnvironmentImageSpawnRow {
  id: string;
  provider_image_id: string | null;
  repositories_fingerprint: string;
  repository_shas: string;
  runtime_version: string;
}

/**
 * Provider-scoped lookup interface for environment images, bound by the
 * Durable Object like RepoImageLookup. Environment images run on the same
 * provider set as repo images.
 */
export interface EnvironmentImageLookup {
  /** Latest ready image for the environment on the active provider. */
  getLatestReady(environmentId: string): Promise<EnvironmentImageSpawnRow | null>;
  /**
   * Fail a ready image whose provider artifact could not be restored, so the
   * rebuild cron sees no ready image and rebuilds it (design §7.3 remedy b).
   */
  markRestoreFailed(environmentImageId: string, error: string): Promise<boolean>;
}

/** A matched image, reduced to what the spawn config needs. */
export interface SelectedEnvironmentImage {
  environmentImageId: string;
  providerImageId: string;
  /**
   * The primary repository's baked SHA — the scalar repoImageSha mirror
   * (repository_shas is position-ordered, primary first). Null when the
   * provenance document is missing or unparseable; the SHA is informational
   * (boot logging), so a null must not fail the match.
   */
  primaryBaseSha: string | null;
  runtimeVersion: string;
}

export type EnvironmentImageMissReason =
  | "no_ready_image"
  | "missing_artifact"
  | "runtime_below_floor"
  | "fingerprint_mismatch";

export type EnvironmentImageSelectionResult =
  | { outcome: "selected"; image: SelectedEnvironmentImage }
  | { outcome: "miss"; reason: EnvironmentImageMissReason; environmentImageId?: string };

/**
 * Evaluate the latest ready image (or its absence) against the session's own
 * repository snapshot. Checks run cheapest-first; the floor fails closed on an
 * unparseable runtime version (an unversioned image must never boot a
 * multi-repo workspace).
 */
export async function evaluateEnvironmentImageForSpawn(
  image: EnvironmentImageSpawnRow | null,
  sessionRepositories: FingerprintRepositoryInput[]
): Promise<EnvironmentImageSelectionResult> {
  if (!image) {
    return { outcome: "miss", reason: "no_ready_image" };
  }
  if (!image.provider_image_id) {
    // Ready rows always record their artifact at mark-ready time; defensive
    // against direct store writes.
    return { outcome: "miss", reason: "missing_artifact", environmentImageId: image.id };
  }

  const runtimeVersion = parseRuntimeVersionNumber(image.runtime_version);
  if (runtimeVersion === null || runtimeVersion < MIN_COMPATIBLE_RUNTIME_VERSION) {
    return { outcome: "miss", reason: "runtime_below_floor", environmentImageId: image.id };
  }

  const sessionFingerprint = await computeRepositoriesFingerprint(sessionRepositories);
  if (image.repositories_fingerprint !== sessionFingerprint) {
    return { outcome: "miss", reason: "fingerprint_mismatch", environmentImageId: image.id };
  }

  return {
    outcome: "selected",
    image: {
      environmentImageId: image.id,
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
