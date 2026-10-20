import { describe, expect, it } from "vitest";
import { createPiDeploymentCapabilitySnapshot } from "../pi/deployment-capabilities";
import { resolveSandboxExecutionCapability } from "./execution-capability";

const providers = ["modal", "modal-vm", "opencomputer", "daytona", "vercel", "e2b"] as const;

function evidence(provider: (typeof providers)[number]) {
  return JSON.stringify({
    runtimeVersion: "v78-execution-isolation-boundary",
    artifactGeneration: 78,
    artifactSha256: "a".repeat(64),
    networkProfile: "package-install-v1",
    providers: Object.fromEntries(
      providers.map((candidate) => [
        candidate,
        candidate === provider
          ? { status: "passed", attestedAt: "2026-10-20T00:00:00.000Z" }
          : { status: "canary_blocked", limitations: ["not attested"] },
      ])
    ),
  });
}

describe("sandbox execution capability", () => {
  it.each(providers)("keeps real provider %s unavailable even when mode is enabled", (provider) => {
    expect(
      resolveSandboxExecutionCapability({
        mode: "enabled",
        provider,
        attestation: evidence(provider),
      })
    ).toEqual({ available: false, provider, reason: "provider_canary_blocked" });
  });

  it("requires valid generation, artifact, profile, and provider evidence in fake enforcement", () => {
    expect(
      resolveSandboxExecutionCapability({
        mode: "enabled",
        provider: "modal",
        attestation: evidence("modal"),
        providerIsolation: "enforced",
      })
    ).toEqual({
      available: true,
      provider: "modal",
      artifactGeneration: 78,
      runtimeVersion: "v78-execution-isolation-boundary",
      networkProfile: "package-install-v1",
    });
    expect(
      resolveSandboxExecutionCapability({
        mode: "enabled",
        provider: "modal",
        attestation: "{}",
        providerIsolation: "enforced",
      })
    ).toMatchObject({ available: false, reason: "attestation_invalid" });
  });

  it("latches sandbox execution off for real deployments and on only for fake attested tests", () => {
    const config = {
      PI_SANDBOX_EXECUTION_MODE: "enabled",
      SANDBOX_PROVIDER: "modal",
      PI_SANDBOX_EXECUTION_ATTESTATION: evidence("modal"),
    };
    expect(createPiDeploymentCapabilitySnapshot(config).capabilities.sandboxExecution).toBe("off");
    expect(
      createPiDeploymentCapabilitySnapshot(config, "enforced").capabilities.sandboxExecution
    ).toBe("enabled");
  });
});
