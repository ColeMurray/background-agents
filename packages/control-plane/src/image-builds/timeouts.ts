import { MAX_BUILD_TIMEOUT_SECONDS } from "@open-inspect/shared";

const MS_PER_SECOND = 1000;

/** Queue delivery plus the longest supported provider snapshot/checkpoint attempt. */
export const IMAGE_BUILD_FINALIZATION_GRACE_MS = 10 * 60 * MS_PER_SECOND;

/** Extra registration/dispatch margin before a row is declared stale. */
export const IMAGE_BUILD_STALE_DISPATCH_GRACE_MS = 5 * 60 * MS_PER_SECOND;

/** Longest supported build execution plus the reserved finalization window. */
export const MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS =
  MAX_BUILD_TIMEOUT_SECONDS * MS_PER_SECOND + IMAGE_BUILD_FINALIZATION_GRACE_MS;

/**
 * Provider sessions must outlive the user-configured build-execution budget:
 * after setup reports success, the Queue consumer still needs time to receive
 * the callback and create the provider artifact.
 */
export function resolveImageBuildProviderSessionTimeoutMs(buildTimeoutMs: number): number {
  return buildTimeoutMs + IMAGE_BUILD_FINALIZATION_GRACE_MS;
}

/** Provider-session budget in the whole seconds expected by provider APIs. */
export function resolveImageBuildProviderSessionTimeoutSeconds(buildTimeoutMs: number): number {
  return Math.ceil(resolveImageBuildProviderSessionTimeoutMs(buildTimeoutMs) / MS_PER_SECOND);
}
