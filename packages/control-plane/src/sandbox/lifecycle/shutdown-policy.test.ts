import { describe, expect, it } from "vitest";
import { MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION } from "../runtime-manifest";
import { shutdownPolicyForLaunch, supportsConfirmedShutdown } from "./shutdown-policy";

describe("shutdown lifecycle policy", () => {
  it("requires confirmed graceful shutdown for every new launch", () => {
    expect(shutdownPolicyForLaunch("new", null)).toBe("confirmed");
    expect(shutdownPolicyForLaunch("new", "v1-legacy")).toBe("confirmed");
  });

  it("keeps existing state legacy until its runtime is known capable", () => {
    expect(shutdownPolicyForLaunch("existing", null)).toBe("legacy");
    expect(
      shutdownPolicyForLaunch("existing", `v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION - 1}-legacy`)
    ).toBe("legacy");
    expect(
      shutdownPolicyForLaunch("existing", `v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION}-confirmed`)
    ).toBe("confirmed");
    expect(supportsConfirmedShutdown("invalid")).toBe(false);
  });
});
