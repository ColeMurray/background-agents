import { describe, expect, it } from "vitest";
import { deploymentCapabilities } from "./health";

describe("deploymentCapabilities", () => {
  it("advertises Pi only from the live flag and binding and exposes no configuration secrets", () => {
    const capabilities = deploymentCapabilities({
      PI_DURABLE_ENABLED: "true",
      PI_SESSION: {},
      PI_WORKSPACE_MODE: "read_only",
      PI_CODE_MODE: "off",
      ANTHROPIC_API_KEY: "SECRET_SENTINEL",
    } as never);

    expect(capabilities.harnesses.find((harness) => harness.id === "pi")).toMatchObject({
      available: true,
      executionBackend: "durable_object",
      modelProviders: ["openai"],
      authModes: ["provider_account"],
    });
    expect(capabilities.pi).toMatchObject({
      enabled: true,
      bindingReachable: true,
      modes: { scratchWorkspace: "read_only", codeMode: "off" },
    });
    expect(JSON.stringify(capabilities)).not.toContain("SECRET_SENTINEL");
  });

  it("fails Pi availability closed when the binding is absent", () => {
    const capabilities = deploymentCapabilities({ PI_DURABLE_ENABLED: "true" } as never);
    expect(capabilities.pi.enabled).toBe(false);
    expect(capabilities.harnesses.find((harness) => harness.id === "pi")?.available).toBe(false);
  });

  it("keeps sandbox execution undiscoverable while the selected provider is canary-blocked", () => {
    const capabilities = deploymentCapabilities({
      PI_SANDBOX_EXECUTION_MODE: "enabled",
      SANDBOX_PROVIDER: "modal",
    } as never);
    expect(capabilities.pi.modes.sandboxExecution).toBe("off");
    expect(capabilities.pi.canary.sandboxExecution).toEqual({
      available: false,
      provider: "modal",
      reason: "provider_canary_blocked",
    });
  });
});
