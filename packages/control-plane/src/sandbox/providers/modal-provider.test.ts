/**
 * Unit tests for ModalSandboxProvider.
 *
 * Tests error classification logic for circuit breaker handling.
 */

import { describe, it, expect, vi } from "vitest";
import { ModalSandboxProvider } from "./modal-provider";
import { SandboxProviderError } from "../provider";
import type { ModalClient, CreateSandboxRequest, CreateSandboxResponse } from "../client";

// ==================== Mock Factories ====================

function createMockModalClient(
  overrides: Partial<{
    createSandbox: (req: CreateSandboxRequest) => Promise<CreateSandboxResponse>;
    getSnapshotSandboxUrl: () => string;
    getRestoreSandboxUrl: () => string;
  }> = {}
): ModalClient {
  return {
    createSandbox: vi.fn(
      async (): Promise<CreateSandboxResponse> => ({
        sandboxId: "sandbox-123",
        modalObjectId: "modal-obj-123",
        status: "created",
        createdAt: Date.now(),
      })
    ),
    getSnapshotSandboxUrl: vi.fn(() => "https://test-snapshot.modal.run"),
    getRestoreSandboxUrl: vi.fn(() => "https://test-restore.modal.run"),
    ...overrides,
  } as unknown as ModalClient;
}

const testConfig = {
  sessionId: "test-session",
  sandboxId: "sandbox-123",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
};

// ==================== Tests ====================

describe("ModalSandboxProvider", () => {
  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "test-secret");

      expect(provider.name).toBe("modal");
      expect(provider.capabilities.supportsSnapshots).toBe(true);
      expect(provider.capabilities.supportsRestore).toBe(true);
      expect(provider.capabilities.supportsWarm).toBe(true);
    });
  });

  describe("error classification", () => {
    describe("transient errors", () => {
      it("classifies 'fetch failed' as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("fetch failed");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);
        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'ETIMEDOUT' as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("connect ETIMEDOUT 192.168.1.1:443");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'ECONNRESET' as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("read ECONNRESET");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'ECONNREFUSED' as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'network' errors as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Network request failed");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'timeout' errors as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Request timeout after 30000ms");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies HTTP 502 as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 502 Bad Gateway");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies HTTP 503 as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 503 Service Unavailable");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies HTTP 504 as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 504 Gateway Timeout");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'bad gateway' (lowercase) as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("upstream bad gateway error");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'service unavailable' (lowercase) as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("service unavailable, try again later");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies 'gateway timeout' (lowercase) as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("gateway timeout while waiting for upstream");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });
    });

    describe("permanent errors", () => {
      it("classifies HTTP 401 (unauthorized) as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 401 Unauthorized");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("classifies HTTP 403 (forbidden) as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 403 Forbidden");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("classifies HTTP 400 (bad request) as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 400 Bad Request - Invalid configuration");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("classifies HTTP 422 (unprocessable) as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Modal API error: 422 Unprocessable Entity");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("classifies configuration errors as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Invalid repository configuration");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("classifies quota errors as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Quota exceeded: maximum sandboxes reached");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("classifies unknown errors as permanent (default)", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("Something unexpected happened");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
        }
      });

      it("handles non-Error objects as permanent", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw "string error"; // Throwing a string, not an Error
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
          expect((e as SandboxProviderError).message).toContain("string error");
        }
      });
    });

    describe("error propagation", () => {
      it("preserves original error as cause", async () => {
        const originalError = new Error("Original network timeout error");
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw originalError;
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).cause).toBe(originalError);
        }
      });

      it("includes descriptive message with context", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new Error("timeout exceeded");
          }),
        });
        const provider = new ModalSandboxProvider(client, "test-secret");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).message).toContain("Failed to create sandbox");
          expect((e as SandboxProviderError).message).toContain("timeout exceeded");
        }
      });
    });
  });

  describe("createSandbox", () => {
    it("returns correct result on success", async () => {
      const expectedResult = {
        sandboxId: "sandbox-abc",
        modalObjectId: "modal-obj-xyz",
        status: "created",
        createdAt: 1234567890,
      };

      const client = createMockModalClient({
        createSandbox: vi.fn(async () => expectedResult),
      });
      const provider = new ModalSandboxProvider(client, "test-secret");

      const result = await provider.createSandbox(testConfig);

      expect(result.sandboxId).toBe("sandbox-abc");
      expect(result.providerObjectId).toBe("modal-obj-xyz");
      expect(result.status).toBe("created");
      expect(result.createdAt).toBe(1234567890);
    });
  });

  describe("HTTP status handling", () => {
    it("classifies HTTP 502 from restoreFromSnapshot as transient", async () => {
      // Mock fetch to return 502
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      })) as unknown as typeof fetch;

      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "test-secret");

      try {
        await provider.restoreFromSnapshot({
          snapshotImageId: "img-123",
          sessionId: "session-123",
          sandboxId: "sandbox-123",
          sandboxAuthToken: "token",
          controlPlaneUrl: "https://test.com",
          repoOwner: "owner",
          repoName: "repo",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("classifies HTTP 401 from restoreFromSnapshot as permanent", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;

      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "test-secret");

      try {
        await provider.restoreFromSnapshot({
          snapshotImageId: "img-123",
          sessionId: "session-123",
          sandboxId: "sandbox-123",
          sandboxAuthToken: "token",
          controlPlaneUrl: "https://test.com",
          repoOwner: "owner",
          repoName: "repo",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("classifies HTTP 503 from takeSnapshot as transient", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof fetch;

      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "test-secret");

      try {
        await provider.takeSnapshot({
          providerObjectId: "obj-123",
          sessionId: "session-123",
          reason: "test",
        });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns providerObjectId from restoreFromSnapshot", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            sandbox_id: "restored-sandbox-123",
            modal_object_id: "new-modal-obj-456",
          },
        }),
      })) as unknown as typeof fetch;

      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "test-secret");

      const result = await provider.restoreFromSnapshot({
        snapshotImageId: "img-123",
        sessionId: "session-123",
        sandboxId: "sandbox-123",
        sandboxAuthToken: "token",
        controlPlaneUrl: "https://test.com",
        repoOwner: "owner",
        repoName: "repo",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });

      expect(result.success).toBe(true);
      expect(result.sandboxId).toBe("restored-sandbox-123");
      expect(result.providerObjectId).toBe("new-modal-obj-456");

      globalThis.fetch = originalFetch;
    });
  });
});
