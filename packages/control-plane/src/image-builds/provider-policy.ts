import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import {
  IMAGE_BUILD_PROVIDER_IDS,
  imageBuildProviderSchema,
  type ImageBuildProvider,
} from "./model";

/**
 * Central provider policy for image-build support.
 *
 * Keep capability and callback-mode decisions here so routes/workflows can work
 * from provider-neutral lifecycle terms instead of open-coded provider checks.
 */

export function getImageBuildsUnsupportedMessage(env: Env): string | null {
  if (resolveImageBuildProvider(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return `Image builds are only available when SANDBOX_PROVIDER=${IMAGE_BUILD_PROVIDER_IDS.join(", ")}`;
}

export function resolveImageBuildProvider(value: string | undefined): ImageBuildProvider | null {
  const provider = resolveSandboxBackendName(value);
  return isImageBuildProvider(provider) ? provider : null;
}

/** Why a deployment is not starting new builds or selecting prebuilt images. */
export type ImageBuildAdmissionClosedReason = "provider_unsupported" | "daytona_prebuilds_disabled";

/**
 * Whether this deployment admits NEW image-build work.
 *
 * Distinct from provider support and from per-scope enablement: a provider
 * can support prebuilds, and scopes can be enabled for them, while an
 * operator keeps the deployment from creating any. That is the rollout and
 * rollback control, and it governs exactly two things — starting a build and
 * selecting a prebuilt image for a fresh session.
 *
 * Everything a build already started keeps working while admission is
 * closed: its callbacks are accepted, its finalization runs, its status is
 * readable, and its resources are reclaimed. Closing admission must never
 * strand a resource.
 */
export interface ImageBuildAdmission {
  /** The provider new builds would run on, or null when none supports them. */
  provider: ImageBuildProvider | null;
  admitted: boolean;
  reason?: ImageBuildAdmissionClosedReason;
}

export function resolveImageBuildAdmission(env: Env): ImageBuildAdmission {
  const provider = resolveImageBuildProvider(env.SANDBOX_PROVIDER);
  if (!provider) return { provider: null, admitted: false, reason: "provider_unsupported" };
  if (provider !== "daytona") return { provider, admitted: true };
  // Daytona prebuilds open only when an operator says so: the provider's
  // capture, activation and lifetime behavior has to be proven against the
  // actual deployment first.
  return isTruthyFlag(env.DAYTONA_PREBUILDS_ENABLED)
    ? { provider, admitted: true }
    : { provider, admitted: false, reason: "daytona_prebuilds_disabled" };
}

function isTruthyFlag(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

function isImageBuildProvider(provider: SandboxBackendName): provider is ImageBuildProvider {
  return imageBuildProviderSchema.safeParse(provider).success;
}
