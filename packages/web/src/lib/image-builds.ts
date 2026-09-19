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

/**
 * Whether the deployment will act on a prebuild toggle at all. A paused
 * deployment keeps serving status and cleanup, so the controls stay readable
 * — they just stop promising builds that would be refused.
 */
const imageBuildAdmissionSchema = z.object({
  open: z.boolean(),
  reason: z.string().optional(),
});

type ImageBuildAdmissionView = z.infer<typeof imageBuildAdmissionSchema>;

/**
 * What admission means when the control plane reports none: a control plane
 * that predates the control admits everything.
 */
export const DEFAULT_IMAGE_BUILD_ADMISSION_OPEN = true;

export const imageBuildsEnabledResponseSchema = z.object({
  units: z.array(imageBuildUnitViewSchema),
  // Optional so a web build can run against a control plane that predates it.
  admission: imageBuildAdmissionSchema.optional(),
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
  /** Absent when the control plane does not report it; treated as open. */
  admission?: ImageBuildAdmissionView;
}

/**
 * Drop superseded rows. The status endpoints don't emit them, but
 * `ImageBuildStatus` admits them — this is the one defensive filter, applied
 * where the web fetches build rows from the control plane.
 */
export function excludeSupersededBuilds(images: ImageBuildRecordView[]): ImageBuildRecordView[] {
  return images.filter((image) => image.status !== "superseded");
}

/**
 * Drop rows built on another provider.
 *
 * The status feed is cross-provider history: a deployment that switched
 * providers keeps its old ready rows so their artifacts can still be
 * reclaimed. Showing one as this deployment's prebuild would promise a boot
 * that spawn selection — which matches on provider — will never perform.
 */
export function excludeOtherProviderBuilds(
  images: ImageBuildRecordView[],
  provider: string
): ImageBuildRecordView[] {
  return images.filter((image) => image.provider === provider);
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
 * Fold each scope's build rows to one status: ready > building > failed.
 *
 * Only rows matching the scope's current fingerprint (per `units`) count —
 * spawn rejects stale-fingerprint rows, so a stale ready row must not outrank
 * a failed current build. A scope with no unit (transiently dropped from the
 * enabled feed) falls back to the unfiltered fold over all its rows.
 */
export function foldImageBuildStatusByScope(
  images: ImageBuildRecordView[],
  units: ImageBuildUnitView[]
): Map<string, ImageBuildStatus> {
  const currentFingerprintByScope = new Map(
    units.map((unit) => [
      imageBuildScopeKey(unit.scopeKind, unit.scopeId),
      unit.repositoriesFingerprint,
    ])
  );
  const statusByScope = new Map<string, ImageBuildStatus>();
  for (const image of images) {
    const key = imageBuildScopeKey(image.scopeKind, image.scopeId);
    const currentFingerprint = currentFingerprintByScope.get(key);
    if (currentFingerprint !== undefined && image.repositoriesFingerprint !== currentFingerprint) {
      continue;
    }
    const current = statusByScope.get(key);
    if (!current || STATUS_FOLD_PRECEDENCE[image.status] > STATUS_FOLD_PRECEDENCE[current]) {
      statusByScope.set(key, image.status);
    }
  }
  return statusByScope;
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
