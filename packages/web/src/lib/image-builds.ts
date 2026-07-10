/**
 * Web-side model helpers for the unified image-build subsystem: the
 * `/api/image-builds` feed shape, superseded-row filtering at the fetch
 * boundary, per-scope status folding for the session-target picker, and the
 * build-provenance accessor shared by both settings surfaces.
 */

import type {
  ImageBuildRecordView,
  ImageBuildScopeKind,
  ImageBuildStatus,
} from "@open-inspect/shared";

/** SWR key for the unified image-build feed. */
export const IMAGE_BUILDS_KEY = "/api/image-builds";

/** One prebuild-enabled scope as served by GET /api/image-builds. */
export interface ImageBuildUnitView {
  scopeKind: ImageBuildScopeKind;
  scopeId: string;
}

/** Response shape of GET /api/image-builds. */
export interface ImageBuildsFeed {
  units: ImageBuildUnitView[];
  images: ImageBuildRecordView[];
}

/**
 * Drop superseded rows. The status endpoints don't emit them, but
 * `ImageBuildStatus` admits them — this is the one defensive filter, applied
 * where the web fetches build rows from the control plane.
 */
export function excludeSupersededBuilds(images: ImageBuildRecordView[]): ImageBuildRecordView[] {
  return images.filter((image) => image.status !== "superseded");
}

/** Map key for one build scope in the folded status map. */
export function imageBuildScopeKey(scopeKind: ImageBuildScopeKind, scopeId: string): string {
  return `${scopeKind}:${scopeId}`;
}

const STATUS_FOLD_PRECEDENCE: Record<ImageBuildStatus, number> = {
  ready: 3,
  building: 2,
  failed: 1,
  // Never present (filtered at the fetch boundary); ranked for totality.
  superseded: 0,
};

/**
 * Fold each scope's build rows to one status: ready > building > failed.
 *
 * Caveat (design §6, accepted): a scope holding a stale-fingerprint ready row
 * plus a failed latest build folds to "ready" while spawn will reject the
 * stale row — the feed doesn't carry fingerprints, so the fold can't tell.
 * Revisit if it bites.
 */
export function foldImageBuildStatusByScope(
  images: ImageBuildRecordView[]
): Map<string, ImageBuildStatus> {
  const statusByScope = new Map<string, ImageBuildStatus>();
  for (const image of images) {
    const key = imageBuildScopeKey(image.scope_kind, image.scope_id);
    const current = statusByScope.get(key);
    if (!current || STATUS_FOLD_PRECEDENCE[image.status] > STATUS_FOLD_PRECEDENCE[current]) {
      statusByScope.set(key, image.status);
    }
  }
  return statusByScope;
}

/**
 * The primary repository's baseSha out of a build's provenance document
 * (`repository_shas`, the JSON-encoded RepositoryShaEntry[] column value).
 */
export function parsePrimaryBuildSha(repositoryShas: string): string | null {
  try {
    const parsed: unknown = JSON.parse(repositoryShas);
    if (!Array.isArray(parsed)) return null;
    const primary: unknown = parsed[0];
    if (primary && typeof primary === "object" && "baseSha" in primary) {
      const sha = (primary as { baseSha?: unknown }).baseSha;
      return typeof sha === "string" ? sha : null;
    }
    return null;
  } catch {
    return null;
  }
}
