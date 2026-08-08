import release from "../../sandbox-runtime/src/sandbox_runtime/release.json";

export const OPENCODE_VERSION = release.opencode_version;
export const MANAGED_RUNTIME_VERSION = release.managed_runtime_version;

/**
 * Compatibility floor for prebuilt-image runtimes.
 *
 * Bumped only on breaking runtime changes, never on provider cache revisions.
 * v56 is the managed-provider runtime, the first that consumes provider-
 * availability markers instead of durable OAuth credentials.
 */
export const MIN_COMPATIBLE_RUNTIME_VERSION = release.minimum_compatible_runtime_version;
export const MANAGED_SANDBOX_VERSION = release.managed_sandbox_version;
