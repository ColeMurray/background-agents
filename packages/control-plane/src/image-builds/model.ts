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
  type ImageBuildScopeKind,
  type ImageBuildStatus,
} from "@open-inspect/shared";

/**
 * Providers with image-build support: Modal images, Vercel snapshots,
 * OpenComputer checkpoints. Daytona has no image support.
 */
export type ImageBuildProvider = "modal" | "vercel" | "opencomputer";

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
  /**
   * OpenComputer only: the per-build secret store the checkpoint retains as its
   * base layer, reaped together with the image. Null for Modal/Vercel, whose
   * artifacts are self-contained.
   */
  providerSecretStoreId?: string | null;
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
  providerSessionId: string | null;
  status: ImageBuildStatus;
}

/**
 * Compatibility floor for prebuilt-image runtimes.
 *
 * Bumped ONLY on breaking runtime changes, never on routine CACHE_BUSTER
 * bumps. v53 is the list-native runtime — the first that can boot a
 * multi-repo workspace — so no image baked by an earlier runtime may ever be
 * selected for a session.
 */
export const MIN_COMPATIBLE_RUNTIME_VERSION = 53;

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
