import { describe, expect, it } from "vitest";
import { MAX_BUILD_TIMEOUT_SECONDS } from "@open-inspect/shared";
import { VERCEL_MAX_SANDBOX_TIMEOUT_MS } from "../sandbox/providers/vercel/provider";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";

describe("DEFAULT_STALE_BUILD_MAX_AGE_MS", () => {
  it("matches the historical 70-minute sweep threshold", () => {
    expect(DEFAULT_STALE_BUILD_MAX_AGE_MS).toBe(4_200_000);
  });

  // The stale mark presumes a `building` row older than the threshold is
  // dead, so each provider's build-sandbox lifetime ceiling must stay at or
  // under it — otherwise the mark fails live builds mid-flight and the scope
  // loops on rebuilds. (Dispatch/queue delay before sandbox start is absorbed
  // by the margin, not modeled; see the constant's doc comment.)

  it("covers the shared build-timeout ceiling (Modal and OpenComputer)", () => {
    // Both providers' sandbox lifetimes are capped at MAX_BUILD_TIMEOUT_SECONDS
    // by the planner (resolveBuildTimeoutSeconds). Strict: the Modal build
    // worker additionally idles through the snapshot budget plus a margin —
    // build_function_timeout_seconds in packages/modal-infra/src/sandbox/manager.py.
    expect(MAX_BUILD_TIMEOUT_SECONDS * 1000).toBeLessThan(DEFAULT_STALE_BUILD_MAX_AGE_MS);
  });

  it("covers Vercel's sandbox lifetime ceiling", () => {
    expect(VERCEL_MAX_SANDBOX_TIMEOUT_MS).toBeLessThanOrEqual(DEFAULT_STALE_BUILD_MAX_AGE_MS);
  });
});
