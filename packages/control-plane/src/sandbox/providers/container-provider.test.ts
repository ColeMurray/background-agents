import { describe, it, expect, vi } from "vitest";
import { CloudflareContainerProvider } from "./container-provider";
import { SandboxProviderError } from "../provider";

function createMockContainerBinding(
  overrides: {
    fetchResponse?: Response;
    fetchError?: Error;
  } = {}
) {
  const fetchFn = overrides.fetchError
    ? vi.fn().mockRejectedValue(overrides.fetchError)
    : vi.fn().mockResolvedValue(
        overrides.fetchResponse ??
          new Response(JSON.stringify({ success: true, sandboxId: "sandbox-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

  const stub = { fetch: fetchFn };

  return {
    idFromName: vi.fn().mockReturnValue("mock-do-id"),
    get: vi.fn().mockReturnValue(stub),
    _stub: stub,
    _fetchFn: fetchFn,
  } as unknown as DurableObjectNamespace;
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
  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const binding = createMockContainerBinding();
      const provider = new CloudflareContainerProvider(binding, {});
      expect(provider.name).toBe("cloudflare-container");
      expect(provider.capabilities.supportsSnapshots).toBe(false);
      expect(provider.capabilities.supportsRestore).toBe(false);
      expect(provider.capabilities.supportsWarm).toBe(false);
    });
  });

  describe("createSandbox", () => {
    it("creates sandbox successfully", async () => {
      const binding = createMockContainerBinding();
      const provider = new CloudflareContainerProvider(binding, {});
      const result = await provider.createSandbox(testConfig);
      expect(result.sandboxId).toBe("sandbox-123");
      expect(result.status).toBe("warming");
      expect(result.createdAt).toBeGreaterThan(0);
    });

    it("passes sandbox ID to idFromName for session affinity", async () => {
      const binding = createMockContainerBinding();
      const provider = new CloudflareContainerProvider(binding, {});
      await provider.createSandbox(testConfig);
      expect(binding.idFromName).toHaveBeenCalledWith("sandbox-123");
    });

    it("sends correct config to container /configure endpoint", async () => {
      const binding = createMockContainerBinding();
      const secrets = { anthropicApiKey: "sk-test", githubAppId: "123" };
      const provider = new CloudflareContainerProvider(binding, secrets);
      await provider.createSandbox(testConfig);

      const fetchFn = (binding as any)._fetchFn;
      expect(fetchFn).toHaveBeenCalledWith(
        "http://container/configure",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      // Verify body contains secrets
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.anthropicApiKey).toBe("sk-test");
      expect(body.githubAppId).toBe("123");
      expect(body.sandboxId).toBe("sandbox-123");
    });

    it("classifies network errors as transient", async () => {
      const binding = createMockContainerBinding({
        fetchError: new Error("fetch failed: connection refused"),
      });
      const provider = new CloudflareContainerProvider(binding, {});

      try {
        await provider.createSandbox(testConfig);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies HTTP 500 as permanent", async () => {
      const binding = createMockContainerBinding({
        fetchResponse: new Response("Internal Server Error", { status: 500 }),
      });
      const provider = new CloudflareContainerProvider(binding, {});

      try {
        await provider.createSandbox(testConfig);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies HTTP 503 as transient", async () => {
      const binding = createMockContainerBinding({
        fetchResponse: new Response("Service Unavailable", { status: 503 }),
      });
      const provider = new CloudflareContainerProvider(binding, {});

      try {
        await provider.createSandbox(testConfig);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });
});
