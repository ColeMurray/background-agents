import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxProviderError } from "../provider";
import type { Sandbox } from "../../containers/sandbox-container";

// Mock @cloudflare/sandbox via the re-export module
vi.mock("../../containers/sandbox-container", () => ({
  getSandbox: vi.fn(),
  Sandbox: class {},
}));

function createMockSandbox(overrides: Record<string, unknown> = {}) {
  return {
    gitCheckout: vi.fn().mockResolvedValue({ success: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, success: true }),
    ...overrides,
  };
}

const testConfig = {
  sessionId: "test-session",
  sandboxId: "sandbox-123",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("CloudflareContainerProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports correct capabilities", async () => {
    const { CloudflareContainerProvider } = await import("./container-provider");
    const binding = {} as unknown as DurableObjectNamespace<Sandbox>;
    const provider = new CloudflareContainerProvider(binding, {});
    expect(provider.name).toBe("cloudflare-sandbox");
    expect(provider.capabilities.supportsSnapshots).toBe(false);
    expect(provider.capabilities.supportsRestore).toBe(false);
    expect(provider.capabilities.supportsWarm).toBe(false);
  });

  it("creates sandbox with correct SDK calls", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const mockSandbox = createMockSandbox();
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const { CloudflareContainerProvider } = await import("./container-provider");
    const binding = {} as unknown as DurableObjectNamespace<Sandbox>;
    const provider = new CloudflareContainerProvider(binding, { anthropicApiKey: "sk-test" });

    const result = await provider.createSandbox(testConfig);

    expect(result.sandboxId).toBe("sandbox-123");
    expect(result.status).toBe("warming");

    // Verify gitCheckout called
    expect(mockSandbox.gitCheckout).toHaveBeenCalledWith(
      "https://github.com/testowner/testrepo.git",
      expect.objectContaining({ targetDir: "/workspace/testrepo", depth: 100 })
    );

    // Verify exec called with env option (not inline shell exports)
    expect(mockSandbox.exec).toHaveBeenCalledWith(
      "cd /workspace/testrepo && python3 -m sandbox_runtime.entrypoint",
      expect.objectContaining({
        env: expect.objectContaining({
          SANDBOX_ID: "sandbox-123",
          CONTROL_PLANE_URL: "https://control-plane.test",
          SANDBOX_AUTH_TOKEN: "auth-token",
          ANTHROPIC_API_KEY: "sk-test",
          RESTORED_FROM_SNAPSHOT: "true",
        }),
      })
    );
  });

  it("wraps errors as SandboxProviderError", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const mockSandbox = createMockSandbox({
      gitCheckout: vi.fn().mockRejectedValue(new Error("clone failed")),
    });
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const { CloudflareContainerProvider } = await import("./container-provider");
    const binding = {} as unknown as DurableObjectNamespace<Sandbox>;
    const provider = new CloudflareContainerProvider(binding, {});

    await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);
  });

  it("re-throws SandboxProviderError without wrapping", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const original = new SandboxProviderError("test error", "permanent");
    const mockSandbox = createMockSandbox({
      gitCheckout: vi.fn().mockRejectedValue(original),
    });
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const { CloudflareContainerProvider } = await import("./container-provider");
    const binding = {} as unknown as DurableObjectNamespace<Sandbox>;
    const provider = new CloudflareContainerProvider(binding, {});

    try {
      await provider.createSandbox(testConfig);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBe(original);
    }
  });
});
