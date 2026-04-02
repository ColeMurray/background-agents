import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxProviderError } from "../provider";

// Mock @cloudflare/sandbox via the re-export module
vi.mock("../../containers/sandbox-container", () => ({
  getSandbox: vi.fn(),
  SandboxContainer: class {},
}));

function createMockSandbox(overrides: Record<string, unknown> = {}) {
  const mockProcess = {
    waitForPort: vi.fn().mockResolvedValue(undefined),
    id: "proc-1",
  };
  return {
    setEnvVars: vi.fn().mockResolvedValue(undefined),
    gitCheckout: vi.fn().mockResolvedValue({ success: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, success: true }),
    startProcess: vi.fn().mockResolvedValue(mockProcess),
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
    const binding = {} as DurableObjectNamespace;
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
    const binding = {} as DurableObjectNamespace;
    const provider = new CloudflareContainerProvider(binding, { anthropicApiKey: "sk-test" });

    const result = await provider.createSandbox(testConfig);

    expect(result.sandboxId).toBe("sandbox-123");
    expect(result.status).toBe("running");

    // Verify SDK calls in order
    expect(mockSandbox.setEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ ANTHROPIC_API_KEY: "sk-test", SANDBOX_ID: "sandbox-123" })
    );
    expect(mockSandbox.gitCheckout).toHaveBeenCalledWith(
      "https://github.com/testowner/testrepo.git",
      expect.objectContaining({ targetDir: "/workspace/testrepo", depth: 100 })
    );
    expect(mockSandbox.exec).toHaveBeenCalled();
    expect(mockSandbox.startProcess).toHaveBeenCalled();
  });

  it("wraps errors as SandboxProviderError", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const mockSandbox = createMockSandbox({
      gitCheckout: vi.fn().mockRejectedValue(new Error("clone failed")),
    });
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const { CloudflareContainerProvider } = await import("./container-provider");
    const binding = {} as DurableObjectNamespace;
    const provider = new CloudflareContainerProvider(binding, {});

    await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);
  });

  it("re-throws SandboxProviderError without wrapping", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const original = new SandboxProviderError("test error", "permanent");
    const mockSandbox = createMockSandbox({
      setEnvVars: vi.fn().mockRejectedValue(original),
    });
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const { CloudflareContainerProvider } = await import("./container-provider");
    const binding = {} as DurableObjectNamespace;
    const provider = new CloudflareContainerProvider(binding, {});

    try {
      await provider.createSandbox(testConfig);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBe(original);
    }
  });
});
