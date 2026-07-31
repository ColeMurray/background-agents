import { describe, expect, it } from "vitest";
import { VERCEL_MAX_SANDBOX_TIMEOUT_MS } from "../sandbox/providers/vercel/provider";
import { DEFAULT_ARTIFACT_CLEANUP_MAX_AGE_MS, DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import { MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS } from "./timeouts";

describe("DEFAULT_STALE_BUILD_MAX_AGE_MS", () => {
  it("retains failed build history for one day before cleanup", () => {
    expect(DEFAULT_ARTIFACT_CLEANUP_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("leaves dispatch grace beyond the longest provider-session lifetime", () => {
    expect(DEFAULT_STALE_BUILD_MAX_AGE_MS).toBe(4_500_000);
  });

  // The stale mark presumes a `building` row older than the threshold is
  // dead, so each provider's build-sandbox lifetime ceiling must stay at or
  // under it — otherwise the mark fails live builds mid-flight and the scope
  // loops on rebuilds. (Dispatch/queue delay before sandbox start is absorbed
  // by the margin, not modeled; see the constant's doc comment.)

  it("strictly exceeds the shared provider-session lifetime ceiling", () => {
    expect(MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS).toBeLessThan(
      DEFAULT_STALE_BUILD_MAX_AGE_MS
    );
  });

  it("covers Vercel's sandbox lifetime ceiling", () => {
    expect(VERCEL_MAX_SANDBOX_TIMEOUT_MS).toBeLessThanOrEqual(DEFAULT_STALE_BUILD_MAX_AGE_MS);
  });
});
