import {
  IMAGE_BUILD_STALE_DISPATCH_GRACE_MS,
  MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS,
} from "./timeouts";

/** Failed build history retained before artifact-free rows are deleted. */
export const DEFAULT_ARTIFACT_CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Age past which a `building` row is presumed dead and safe to fail: sized at
 * the longest provider-session lifetime plus registration/dispatch grace, so
 * a long-but-live build is never reaped.
 *
 * The clock starts at row registration (`created_at`), not sandbox start, so
 * dispatch latency and provider queueing eat into the grace budget. The blast
 * radius of exceeding it is a redundant rebuild —
 * the misclassified build's late callback is rejected by the
 * `status = 'building'` completion guards, never recorded over the new build.
 */
export const DEFAULT_STALE_BUILD_MAX_AGE_MS =
  MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS + IMAGE_BUILD_STALE_DISPATCH_GRACE_MS;
