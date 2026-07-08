/**
 * Domain terms for environment image builds (design §7.3).
 *
 * Environment images generalize repo images to a prebuildable repository set:
 * the artifact is provider-opaque exactly like a repo image, but the build
 * unit is an environment, drift is tracked per member (`member_shas`), and
 * spawn selection is gated by the runtime version baked at build time.
 */
import type { RepoImageProvider } from "../repo-images/model";

/**
 * Environment images run on the same provider set and callback policy as repo
 * images (design §7.3 "Provider coverage"): Modal images, Vercel snapshots,
 * OpenComputer checkpoints. Daytona has no image support for either subsystem.
 */
export type EnvironmentImageProvider = RepoImageProvider;

export type EnvironmentImageBuildStatus = "building" | "ready" | "failed" | "superseded";

/**
 * One member's clone provenance at build time.
 *
 * This is a single cross-language document shape: produced by the sandbox
 * runtime, echoed through build callbacks, stored verbatim in
 * `environment_images.member_shas`, and compared against `git ls-remote` by
 * the rebuild cron. Keep the field names in sync with
 * `sandbox_runtime/entrypoint.py` rather than remapping at each boundary.
 */
export interface EnvironmentImageMemberSha {
  repoOwner: string;
  repoName: string;
  baseSha: string;
}

/** Opaque provider artifact reference, optionally tied to the build sandbox that produced it. */
export interface EnvironmentImageProviderImageRef {
  providerImageId: string;
  providerSessionId?: string | null;
}

export interface SupersededEnvironmentImage {
  environmentImageId: string;
  image: EnvironmentImageProviderImageRef;
}

export type MarkEnvironmentImageReadyResult =
  | { type: "marked_ready"; supersededImages: SupersededEnvironmentImage[] }
  | { type: "superseded_by_newer_ready"; supersededImage: SupersededEnvironmentImage }
  | { type: "not_accepting_completion" };

/** Minimal build row shape needed before accepting a callback. */
export interface EnvironmentImageCallbackBuild {
  id: string;
  environmentId: string;
  provider: EnvironmentImageProvider;
  providerSessionId: string | null;
  status: EnvironmentImageBuildStatus;
}

/**
 * Compatibility floor for environment-image runtimes (design §7.3).
 *
 * Bumped ONLY on breaking runtime changes, never on routine CACHE_BUSTER
 * bumps. v53 is the list-native runtime — the first that can boot a
 * multi-repo workspace — so no image baked by an earlier runtime may ever be
 * selected for an environment session.
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
