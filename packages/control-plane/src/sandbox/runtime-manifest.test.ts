import { describe, expect, it } from "vitest";
import {
  MIN_PI_SANDBOX_EXECUTION_RUNTIME_VERSION,
  supportsPiSandboxExecution,
} from "../image-builds/model";
import { MIN_REBUILD_RUNTIME_GENERATION, SANDBOX_RUNTIME_GENERATION } from "./runtime-manifest";

describe("Pi sandbox execution runtime floor", () => {
  it("requires the generation that introduced the execution bridge", () => {
    expect(MIN_PI_SANDBOX_EXECUTION_RUNTIME_VERSION).toBe(78);
    expect(supportsPiSandboxExecution("v76-child-output-discovery")).toBe(false);
    expect(supportsPiSandboxExecution("v77-pi-sandbox-execution")).toBe(false);
    expect(supportsPiSandboxExecution("v78-execution-isolation-boundary")).toBe(true);
  });

  it("forces every provider image to rebuild at the execution generation", () => {
    expect(MIN_REBUILD_RUNTIME_GENERATION).toBe(SANDBOX_RUNTIME_GENERATION);
    expect(MIN_REBUILD_RUNTIME_GENERATION).toBeGreaterThanOrEqual(
      MIN_PI_SANDBOX_EXECUTION_RUNTIME_VERSION
    );
  });
});
