import { describe, expect, it } from "vitest";
import { MIN_COMPATIBLE_RUNTIME_VERSION } from "../image-builds/model";
import { MIN_REBUILD_RUNTIME_VERSION } from "../image-builds/rebuild-policy";
import { OPENCOMPUTER_SANDBOX_VERSION } from "./opencomputer-rest-client";
import { VERCEL_SANDBOX_VERSION } from "./providers/vercel/bootstrap";
import {
  MIN_COMPATIBLE_RUNTIME_GENERATION,
  MIN_REBUILD_RUNTIME_GENERATION,
  SANDBOX_CONTROL_PROTOCOL_V2_MINIMUM_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_VERSION,
  resolveSandboxControlProtocolVersion,
} from "./runtime-manifest";

describe("sandbox runtime manifest", () => {
  it("drives control-plane provider labels and compatibility floors", () => {
    expect(OPENCOMPUTER_SANDBOX_VERSION).toBe(SANDBOX_RUNTIME_VERSION);
    expect(VERCEL_SANDBOX_VERSION).toBe(SANDBOX_RUNTIME_VERSION);
    expect(SANDBOX_RUNTIME_VERSION).toMatch(new RegExp(`^v${SANDBOX_RUNTIME_GENERATION}`));
    expect(MIN_COMPATIBLE_RUNTIME_VERSION).toBe(MIN_COMPATIBLE_RUNTIME_GENERATION);
    expect(MIN_REBUILD_RUNTIME_VERSION).toBe(MIN_REBUILD_RUNTIME_GENERATION);
  });

  it("enforces the v2 activation compatibility barrier", () => {
    expect(MIN_COMPATIBLE_RUNTIME_GENERATION).toBeGreaterThanOrEqual(
      SANDBOX_CONTROL_PROTOCOL_V2_MINIMUM_RUNTIME_GENERATION
    );
    expect(MIN_REBUILD_RUNTIME_GENERATION).toBeGreaterThanOrEqual(
      SANDBOX_CONTROL_PROTOCOL_V2_MINIMUM_RUNTIME_GENERATION
    );
    expect(resolveSandboxControlProtocolVersion("true")).toBe(2);
    expect(resolveSandboxControlProtocolVersion("false")).toBeUndefined();
    expect(resolveSandboxControlProtocolVersion(undefined)).toBeUndefined();
  });
});
