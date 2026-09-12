import { describe, expect, it } from "vitest";
import { MIN_COMPATIBLE_RUNTIME_VERSION } from "../image-builds/model";
import { MIN_REBUILD_RUNTIME_VERSION } from "../image-builds/rebuild-policy";
import { OPENCOMPUTER_SANDBOX_VERSION } from "./opencomputer-rest-client";
import { VERCEL_SANDBOX_VERSION } from "./providers/vercel/bootstrap";
import {
  HARNESS_MIN_RUNTIME_GENERATION,
  MIN_COMPATIBLE_RUNTIME_GENERATION,
  MIN_REBUILD_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_VERSION,
} from "./runtime-manifest";

describe("sandbox runtime manifest", () => {
  it("drives control-plane provider labels and compatibility floors", () => {
    expect(OPENCOMPUTER_SANDBOX_VERSION).toBe(SANDBOX_RUNTIME_VERSION);
    expect(VERCEL_SANDBOX_VERSION).toBe(SANDBOX_RUNTIME_VERSION);
    expect(SANDBOX_RUNTIME_VERSION).toMatch(new RegExp(`^v${SANDBOX_RUNTIME_GENERATION}`));
    expect(MIN_COMPATIBLE_RUNTIME_VERSION).toBe(MIN_COMPATIBLE_RUNTIME_GENERATION);
    expect(MIN_REBUILD_RUNTIME_VERSION).toBe(MIN_REBUILD_RUNTIME_GENERATION);
  });

  it("keeps every per-harness floor between the global floor and the current generation", () => {
    for (const [harness, floor] of Object.entries(HARNESS_MIN_RUNTIME_GENERATION)) {
      expect(floor, harness).toBeGreaterThanOrEqual(MIN_COMPATIBLE_RUNTIME_GENERATION);
      expect(floor, harness).toBeLessThanOrEqual(SANDBOX_RUNTIME_GENERATION);
    }
  });
});
