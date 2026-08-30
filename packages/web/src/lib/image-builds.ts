/**
 * Web-side model helpers for the unified image-build subsystem: the
 * `/api/image-builds` feed shape, superseded-row filtering at the fetch
 * boundary, per-scope status folding for the session-target picker, and the
 * build-provenance accessor shared by both settings surfaces.
 */

import {
  imageBuildScopeKindSchema,
  imageBuildStatusResponseSchema,
  type ImageBuildRecordView,
  type ImageBuildScopeKind,
  type ImageBuildStatus,
  type RepositoryShaEntry,
} from "@open-inspect/shared/types/image-builds";
import { z } from "zod";

/** SWR key for the unified image-build feed. */
export const IMAGE_BUILDS_KEY = "/api/image-builds";

/** Poll cadence for a build-row feed showing a build still in progress. */
export const IMAGE_BUILD_POLL_INTERVAL_MS = 30_000;

/**
 * Background cadence for a loaded, all-terminal feed. Builds also start
 * without any client action — the cron scheduler, and save hooks that run
 * detached from the CRUD response that scheduled them — so a terminal feed
 * keeps refreshing slowly to discover new builds.
 */
export const IMAGE_BUILD_IDLE_POLL_INTERVAL_MS = 120_000;

/**
 * SWR `refreshInterval` for build-row feeds: fast while a build is visibly in
 * progress, slow discovery otherwise. Before the first response (or after an
 * error) this returns 0 — SWR's own retry and revalidation own that phase.
 */
export function imageBuildPollInterval(images: ImageBuildRecordView[] | undefined): number {
  if (!images) return 0;
  return images.some((image) => image.status === "building")
    ? IMAGE_BUILD_POLL_INTERVAL_MS
    : IMAGE_BUILD_IDLE_POLL_INTERVAL_MS;
}

/** One prebuild-enabled scope as served by GET /api/image-builds. */
export const imageBuildUnitViewSchema = z.object({
  scopeKind: imageBuildScopeKindSchema,
  scopeId: z.string(),
  /** The scope's current repo-set fingerprint — build rows with any other fingerprint are stale. */
  repositoriesFingerprint: z.string(),
});

export type ImageBuildUnitView = z.infer<typeof imageBuildUnitViewSchema>;

/** One persisted repo prebuild flag as served by GET /api/image-builds. */
export const imageBuildEnabledRepoViewSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
});

export type ImageBuildEnabledRepoView = z.infer<typeof imageBuildEnabledRepoViewSchema>;

export const imageBuildsEnabledResponseSchema = z.object({
  units: z.array(imageBuildUnitViewSchema),
});

export const imageBuildsEnabledReposResponseSchema = z.object({
  repos: z.array(imageBuildEnabledRepoViewSchema),
});

export const imageBuildsStatusResponseSchema = imageBuildStatusResponseSchema;

/**
 * Response shape of GET /api/image-builds.
 *
 * `units` and `enabledRepos` differ on purpose: units are resolved through
 * source control and can transiently drop a scope, so toggle state must read
 * the persisted `enabledRepos` flags instead.
 */
export interface ImageBuildsFeed {
  units: ImageBuildUnitView[];
  enabledRepos: ImageBuildEnabledRepoView[];
  images: ImageBuildRecordView[];
}

/**
 * Drop superseded rows. The status endpoints don't emit them, but
 * `ImageBuildStatus` admits them — applied with excludeOtherProviderBuilds
 * where the web fetches build rows from the control plane.
 */
export function excludeSupersededBuilds(images: ImageBuildRecordView[]): ImageBuildRecordView[] {
  return images.filter((image) => image.status !== "superseded");
}

/**
 * Drop rows from other sandbox providers. The control plane's status query is
 * not provider-scoped, but everything downstream here is — spawn only uses
 * the active provider's images and the trigger guard is keyed
 * (scope, provider) — so rows left behind by a provider switch must not mask
 * status, pin the rebuild guard, or drive the poll cadence. Applied with
 * excludeSupersededBuilds where the web fetches build rows.
 */
export function excludeOtherProviderBuilds(
  images: ImageBuildRecordView[],
  activeProvider: string
): ImageBuildRecordView[] {
  return images.filter((image) => image.provider === activeProvider);
}

/** Map key for one build scope in the folded status map. */
export function imageBuildScopeKey(scopeKind: ImageBuildScopeKind, scopeId: string): string {
  return `${scopeKind}:${scopeId}`;
}

/**
 * The repo scope id (lowercased owner/name). Repo scopes are keyed lowercase in
 * the feed, so both the enabled-set fold and per-repo status lookups must fold
 * case through here to line up with folded scope ids.
 */
export function repoImageBuildScopeId(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}

/**
 * The set of prebuild-enabled repo scope ids from the feed's persisted flags.
 * Reads `enabledRepos` (not `units`) so a transiently dropped scope still reads
 * as enabled.
 */
export function foldEnabledRepoScopeIds(enabledRepos: ImageBuildEnabledRepoView[]): Set<string> {
  return new Set(enabledRepos.map((flag) => repoImageBuildScopeId(flag.repoOwner, flag.repoName)));
}

const STATUS_FOLD_PRECEDENCE: Record<ImageBuildStatus, number> = {
  ready: 3,
  building: 2,
  failed: 1,
  // Never present (filtered at the fetch boundary); ranked for totality.
  superseded: 0,
};

/**
 * The rows that count toward a scope's status: rows matching the scope's
 * current repo-set fingerprint (per `units`) — spawn rejects
 * stale-fingerprint rows, so no surface may present one as this scope's
 * image. A scope with no unit (transiently dropped from the enabled feed)
 * keeps all its rows. Preserves feed order (createdAt DESC). Shared by the
 * picker's fold and the settings row selector so every surface agrees on
 * which builds exist, even where they answer different questions.
 */
export function currentFingerprintBuilds(
  images: ImageBuildRecordView[],
  units: ImageBuildUnitView[]
): ImageBuildRecordView[] {
  const currentFingerprintByScope = new Map(
    units.map((unit) => [
      imageBuildScopeKey(unit.scopeKind, unit.scopeId),
      unit.repositoriesFingerprint,
    ])
  );
  return images.filter((image) => {
    const currentFingerprint = currentFingerprintByScope.get(
      imageBuildScopeKey(image.scopeKind, image.scopeId)
    );
    return currentFingerprint === undefined || image.repositoriesFingerprint === currentFingerprint;
  });
}

/**
 * Fold each scope's countable rows to one status: ready > building > failed.
 * Answers the session-target picker's question — "will spawn get a prebuilt
 * image?" — so an older ready image outranks a newer failed rebuild.
 */
export function foldImageBuildStatusByScope(
  images: ImageBuildRecordView[],
  units: ImageBuildUnitView[]
): Map<string, ImageBuildStatus> {
  const statusByScope = new Map<string, ImageBuildStatus>();
  for (const image of currentFingerprintBuilds(images, units)) {
    const key = imageBuildScopeKey(image.scopeKind, image.scopeId);
    const current = statusByScope.get(key);
    if (!current || STATUS_FOLD_PRECEDENCE[image.status] > STATUS_FOLD_PRECEDENCE[current]) {
      statusByScope.set(key, image.status);
    }
  }
  return statusByScope;
}

/**
 * One fold of the feed into each scope's newest countable row (the feed is
 * createdAt DESC, so a scope's first row wins). Answers the settings
 * surfaces' question — "what did the latest build attempt do?" — which the
 * rebuild/toggle controls act on. This can legitimately hold `failed` while
 * the picker's fold reports `ready` for the same scope (an older ready image
 * still serves); the two must only ever disagree on precedence, never on
 * which rows count. Memo once per feed change and look rows up by
 * imageBuildScopeKey.
 */
export function latestCurrentBuildsByScope(
  images: ImageBuildRecordView[],
  units: ImageBuildUnitView[]
): Map<string, ImageBuildRecordView> {
  const latestByScope = new Map<string, ImageBuildRecordView>();
  for (const image of currentFingerprintBuilds(images, units)) {
    const key = imageBuildScopeKey(image.scopeKind, image.scopeId);
    if (!latestByScope.has(key)) {
      latestByScope.set(key, image);
    }
  }
  return latestByScope;
}

/**
 * Scope keys with a build in progress under ANY fingerprint. The control
 * plane's trigger guard is not fingerprint-scoped — one active build per
 * scope, and a trigger against it returns `alreadyBuilding` in a 200 the
 * handlers don't read — so rebuild controls must disable on this set even
 * when the display row (latestCurrentBuildsByScope) hides a stale in-flight
 * build.
 */
export function activeBuildScopeKeys(images: ImageBuildRecordView[]): Set<string> {
  return new Set(
    images
      .filter((image) => image.status === "building")
      .map((image) => imageBuildScopeKey(image.scopeKind, image.scopeId))
  );
}

/**
 * The primary repository's baseSha out of a build's decoded provenance.
 */
export function parsePrimaryBuildSha(repositoryShas: RepositoryShaEntry[] | null): string | null {
  return repositoryShas?.[0]?.baseSha ?? null;
}

/** Formats the ready-details line shared by both image families. */
export function formatReadyDetails(
  buildSha: string | null | undefined,
  buildDurationSeconds: number | null | undefined
): string {
  const sha = buildSha ? buildSha.slice(0, 7) : "";
  const duration = buildDurationSeconds ? `${Math.round(buildDurationSeconds)}s` : "";
  return [sha, duration].filter(Boolean).join(" · ");
}
