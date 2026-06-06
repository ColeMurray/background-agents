import { describe, expect, it } from "vitest";
import {
  getProviderCapabilities,
  parseSandboxBackendName,
  PROVIDER_CAPABILITIES,
} from "./sandbox-provider";

describe("parseSandboxBackendName", () => {
  it("defaults to modal when undefined / empty / whitespace", () => {
    expect(parseSandboxBackendName(undefined)).toBe("modal");
    expect(parseSandboxBackendName("")).toBe("modal");
    expect(parseSandboxBackendName("   ")).toBe("modal");
  });

  it("returns the named backend", () => {
    expect(parseSandboxBackendName("modal")).toBe("modal");
    expect(parseSandboxBackendName("daytona")).toBe("daytona");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseSandboxBackendName("MODAL")).toBe("modal");
    expect(parseSandboxBackendName("  Daytona  ")).toBe("daytona");
  });

  it("throws for an unsupported provider", () => {
    expect(() => parseSandboxBackendName("k8s")).toThrow("Unsupported SANDBOX_PROVIDER: k8s");
    expect(() => parseSandboxBackendName("fly")).toThrow("Unsupported SANDBOX_PROVIDER: fly");
  });
});

describe("getProviderCapabilities", () => {
  it("defaults to the modal capability row", () => {
    expect(getProviderCapabilities(undefined)).toBe(PROVIDER_CAPABILITIES.modal);
  });

  it("resolves capabilities by backend name", () => {
    expect(getProviderCapabilities("daytona")).toBe(PROVIDER_CAPABILITIES.daytona);
  });

  it("models docker and prebuilt images as distinct capabilities", () => {
    // Modal is the only backend with prebuilt images / a dashboard URL today.
    expect(PROVIDER_CAPABILITIES.modal.supportsDocker).toBe(true);
    expect(PROVIDER_CAPABILITIES.modal.supportsPrebuiltImages).toBe(true);
    expect(PROVIDER_CAPABILITIES.modal.supportsDashboardUrl).toBe(true);

    expect(PROVIDER_CAPABILITIES.daytona.supportsDocker).toBe(false);
    expect(PROVIDER_CAPABILITIES.daytona.supportsPrebuiltImages).toBe(false);
    expect(PROVIDER_CAPABILITIES.daytona.supportsDashboardUrl).toBe(false);
  });
});
