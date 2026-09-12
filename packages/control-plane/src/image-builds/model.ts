/**
 * Domain terms for image builds.
 *
 * An image build bakes a provider-opaque prebuilt artifact for a *scope* — an
 * environment (an ordered repository set) or, once the repo scope lands, a
 * single repository. The artifact is provider-opaque (Modal image id, Vercel
 * snapshot id, OpenComputer checkpoint id); code outside provider adapters
 * treats those ids as opaque. Drift is tracked per repository
 * (`repository_shas`) and spawn selection is gated by the runtime version
 * baked at build time.
 */
import {
  formatRepositoryFullName,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import type {
  ImageBuildScopeKind,
  ImageBuildStatus,
} from "@open-inspect/shared/types/image-builds";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import {
  HARNESS_MIN_RUNTIME_GENERATION,
  MIN_COMPATIBLE_RUNTIME_GENERATION,
} from "../sandbox/runtime-manifest";

/**
 * Providers with image-build support: Modal images, Vercel snapshots,
 * OpenComputer checkpoints, E2B snapshots. Daytona has no image support.
 */
export type ImageBuildProvider = "modal" | "vercel" | "opencomputer" | "e2b";

/**
 * What an image bakes. `id` is a lowercase `owner/name` pair for repo scopes
 * (construct via repoImageBuildScope so the normalization has one home) and
 * an environment id for environment scopes. Everything downstream of scope
 * resolution (scope.ts) is scope-agnostic.
 */
export interface ImageBuildScope {
  kind: ImageBuildScopeKind;
  id: string;
}

/** The repo scope for a repository, id normalized to lowercase `owner/name`. */
export function repoImageBuildScope(repoOwner: string, repoName: string): ImageBuildScope {
  return {
    kind: "repo",
    id: formatRepositoryFullName({ repoOwner, repoName }).toLowerCase(),
  };
}

/**
 * Split a repo scope id back into its structured identity. Null on malformed
 * values — callers fail closed (a malformed id can only come from a raw store
 * write, never from repoImageBuildScope).
 */
export function parseRepoScopeId(scopeId: string): { repoOwner: string; repoName: string } | null {
  return parseRepositoryFullName(scopeId);
}

/** Opaque provider artifact reference, optionally tied to the build sandbox that produced it. */
export interface ImageBuildProviderImageRef {
  providerImageId: string;
  providerSessionId?: string | null;
}

export interface SupersededImageBuild {
  imageBuildId: string;
  image: ImageBuildProviderImageRef;
}

export type MarkImageBuildReadyResult =
  | { type: "marked_ready"; supersededImages: SupersededImageBuild[] }
  | { type: "superseded_by_newer_ready"; supersededImage: SupersededImageBuild }
  | { type: "not_accepting_completion" };

/** Minimal build row shape needed before accepting a callback. */
export interface ImageBuildCallbackBuild {
  id: string;
  scope: ImageBuildScope;
  provider: ImageBuildProvider;
  status: ImageBuildStatus;
}

/**
 * Compatibility floor for prebuilt-image runtimes.
 *
 * Bumped ONLY on breaking runtime changes, never on routine CACHE_BUSTER
 * bumps. v60 is the first runtime whose managed-provider plugins use the
 * generic token broker, so no image baked by an earlier runtime may be selected.
 */
export const MIN_COMPATIBLE_RUNTIME_VERSION = MIN_COMPATIBLE_RUNTIME_GENERATION;

/**
 * The image floor for a session on `harness`. The global floor retires
 * runtimes no session can boot any more; a harness whose runtime support
 * arrived later names its own generation in the manifest, so its sessions
 * skip older images without retiring any other session's images or
 * snapshots.
 */
export function minCompatibleRuntimeVersionFor(harness: HarnessId): number {
  return Math.max(MIN_COMPATIBLE_RUNTIME_VERSION, HARNESS_MIN_RUNTIME_GENERATION[harness] ?? 0);
}

/**
 * Parse the numeric prefix of a SANDBOX_VERSION ("v53-list-native-runtime"
 * → 53). Returns null when unparseable — callers fail closed: registration
 * rejects the callback, and spawn selection treats the image as below the
 * floor.
 */
export function parseRuntimeVersionNumber(runtimeVersion: string): number | null {
  const match = /^v(\d+)/.exec(runtimeVersion);
  return match ? Number.parseInt(match[1], 10) : null;
}
