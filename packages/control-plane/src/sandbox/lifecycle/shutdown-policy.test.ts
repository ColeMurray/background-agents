import { describe, expect, it } from "vitest";
import {
  MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_VERSION,
} from "../runtime-manifest";
import { shutdownPolicyForLaunch, supportsConfirmedShutdown } from "./shutdown-policy";

describe("shutdown lifecycle policy", () => {
  it("derives the policy from the runtime version a launch boots", () => {
    expect(shutdownPolicyForLaunch(`v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION}-confirmed`)).toBe(
      "confirmed"
    );
    expect(
      shutdownPolicyForLaunch(`v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION + 1}-confirmed`)
    ).toBe("confirmed");
    expect(shutdownPolicyForLaunch(`v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION - 1}-legacy`)).toBe(
      "legacy"
    );
  });

  it("fails closed to legacy for a runtime it cannot identify", () => {
    expect(shutdownPolicyForLaunch(null)).toBe("legacy");
    expect(shutdownPolicyForLaunch("invalid")).toBe("legacy");
    expect(supportsConfirmedShutdown("invalid")).toBe(false);
    expect(supportsConfirmedShutdown(null)).toBe(false);
  });

  it("keeps a new launch on the confirmed protocol, since it boots the deployed runtime", () => {
    // The manifest invariant (runtime-manifest.ts) holds the preservation floor
    // at or below the current generation, so a fresh launch is always capable.
    expect(shutdownPolicyForLaunch(SANDBOX_RUNTIME_VERSION)).toBe("confirmed");
  });
});
