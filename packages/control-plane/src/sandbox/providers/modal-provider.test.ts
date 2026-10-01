/**
 * Unit tests for ModalSandboxProvider.
 *
 * Tests error classification logic for circuit breaker handling.
 */

import { describe, it, expect, vi } from "vitest";
import { ModalSandboxProvider, modalVmAllocationDetail } from "./modal-provider";
import { formatPendingVmReference } from "./pending-vm-reference";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "../lifecycle/decisions";
import { PrebuiltImageUnavailableError, SandboxProviderError } from "../provider";
import { ModalApiError, ModalVmStartupError } from "../client";
import { RequestDeadlineError } from "../request-deadline";
import type {
  ModalClient,
  CreateSandboxRequest,
  CreateSandboxResponse,
  RestoreSandboxRequest,
  RestoreSandboxResponse,
  SnapshotSandboxRequest,
  SnapshotBuildSandboxRequest,
  SnapshotSandboxResponse,
  CreateImageBuildSandboxRequest,
  CreateImageBuildSandboxResponse,
  StartImageBuildSandboxRequest,
  TerminateImageBuildSandboxRequest,
  StopSandboxRequest,
} from "../client";

// ==================== Mock Factories ====================

function createMockModalClient(
  overrides: Partial<{
    createSandbox: (req: CreateSandboxRequest) => Promise<CreateSandboxResponse>;
    restoreSandbox: (req: RestoreSandboxRequest) => Promise<RestoreSandboxResponse>;
    snapshotSandbox: (req: SnapshotSandboxRequest) => Promise<SnapshotSandboxResponse>;
    snapshotBuildSandbox: (req: SnapshotBuildSandboxRequest) => Promise<SnapshotSandboxResponse>;
    createImageBuildSandbox: (
      req: CreateImageBuildSandboxRequest
    ) => Promise<CreateImageBuildSandboxResponse>;
    startImageBuildSandbox: (req: StartImageBuildSandboxRequest) => Promise<void>;
    terminateImageBuildSandbox: (req: TerminateImageBuildSandboxRequest) => Promise<void>;
    stopSandbox: (req: StopSandboxRequest) => Promise<void>;
  }> = {}
): ModalClient {
  return {
    createSandbox: vi.fn(
      async (): Promise<CreateSandboxResponse> => ({
        sandboxId: "sandbox-123",
        modalObjectId: "modal-obj-123",
        createdAt: Date.now(),
      })
    ),
    restoreSandbox: vi.fn(
      async (): Promise<RestoreSandboxResponse> => ({
        sandboxId: "sandbox-123",
        modalObjectId: "modal-obj-123",
      })
    ),
    snapshotSandbox: vi.fn(
      async (): Promise<SnapshotSandboxResponse> => ({
        imageId: "image-123",
      })
    ),
    snapshotBuildSandbox: vi.fn(
      async (): Promise<SnapshotSandboxResponse> => ({
        imageId: "build-image-123",
      })
    ),
    createImageBuildSandbox: vi.fn(
      async (): Promise<CreateImageBuildSandboxResponse> => ({
        providerSessionId: "modal-session-123",
      })
    ),
    startImageBuildSandbox: vi.fn(async () => undefined),
    terminateImageBuildSandbox: vi.fn(async () => undefined),
    stopSandbox: vi.fn(async () => undefined),
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
  harness: "opencode" as const,
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

// ==================== Tests ====================

describe("ModalSandboxProvider", () => {
  it.each(["not_visible", "other_generation", "unknown"] as const)(
    "decodes raw and wrapped VM outcome %s without changing its classification",
    (detail) => {
      for (const error of [
        new ModalApiError("arbitrary message", 409, detail),
        new ModalVmStartupError(detail, new Error("arbitrary message")),
      ]) {
        expect(modalVmAllocationDetail(error)).toBe(detail);
        expect(
          modalVmAllocationDetail(new SandboxProviderError("wrapped", "transient", error))
        ).toBe(detail);
      }
      expect(modalVmAllocationDetail(new TypeError("not_visible"))).toBeUndefined();
    }
  );

  it("standard Modal hooks do not enable VM allocation recovery", () => {
    const provider = new ModalSandboxProvider(createMockModalClient(), "modal");
    expect(provider.pendingSandboxAllocation(testConfig)).toBeUndefined();
    expect(provider.isUnknownStartupError(new ModalApiError("unavailable", 503))).toBe(false);
    expect(
      provider.isUnknownStartupError(new ModalVmStartupError("unknown", new Error("lost response")))
    ).toBe(false);
  });

  it.each([
    [409, "race_pending", true, "transient"],
    [409, "other_generation", false, "permanent"],
    [409, "window_closed", false, "transient"],
    [502, undefined, true, "transient"],
    [500, undefined, true, "transient"],
    [501, "docker_not_available", false, "permanent"],
  ] as const)(
    "classifies VM launch HTTP %s / %s without matching messages",
    async (status, detail, unknown, errorType) => {
      const error = new ModalApiError("arbitrary message", status, detail);
      const provider = new ModalSandboxProvider(
        createMockModalClient({
          createSandbox: async () => {
            throw error;
          },
        }),
        "modal-vm"
      );
      let caught: unknown;
      try {
        await provider.createSandbox({ ...testConfig, generationCreatedAtMs: Date.now() });
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(SandboxProviderError);
      expect((caught as SandboxProviderError).cause).toBe(error);
      expect(provider.isUnknownStartupError(caught)).toBe(unknown);
      expect((caught as SandboxProviderError).errorType).toBe(errorType);
    }
  );

  it("derives a pending VM reference and lifetime from the launch reservation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const createdAt = Date.now();
      const provider = new ModalSandboxProvider(
        createMockModalClient({
          createSandbox: async () => ({
            sandboxId: "sandbox-123",
            modalObjectId: "sb-123",
            createdAt: Date.now(),
            sandboxBackend: "modal-vm",
          }),
          restoreSandbox: async () => ({
            sandboxId: "sandbox-123",
            modalObjectId: "sb-123",
            sandboxBackend: "modal-vm",
          }),
        }),
        "modal-vm"
      );
      const config = { ...testConfig, generationCreatedAtMs: createdAt, timeoutSeconds: 5_400 };
      const pending = provider.pendingSandboxAllocation(config);
      vi.setSystemTime(createdAt + 5_000);

      expect(pending).toEqual({
        reference: 'modal-vm-session:["test-session","sandbox-123"]',
        lifetime: {
          kind: "finite",
          expiresAtMs: createdAt + 5_400_000,
          observedAtMs: createdAt,
          source: "conservative_start_bound",
        },
      });
      expect((await provider.createSandbox(config)).lifetime).toEqual(pending?.lifetime);
      expect(
        (await provider.restoreFromSnapshot({ ...config, snapshotImageId: "im-1" })).lifetime
      ).toEqual(pending?.lifetime);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a conservative pre-request lifetime and propagates final deadlines", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "modal");
      const created = await provider.createSandbox({ ...testConfig, timeoutSeconds: 1200 });
      expect(created.lifetime).toEqual({
        kind: "finite",
        expiresAtMs: Date.parse("2030-01-01T00:20:00.000Z"),
        observedAtMs: Date.parse("2030-01-01T00:00:00.000Z"),
        source: "conservative_start_bound",
      });

      const deadlineAtMs = Date.now() + 30_000;
      await provider.takeSnapshot({
        providerObjectId: "modal-obj-123",
        sessionId: "test-session",
        reason: "final_preservation",
        deadlineAtMs,
      });
      expect(client.snapshotSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineAtMs, signal: expect.any(AbortSignal) }),
        undefined
      );
      await provider.stopSandbox({
        providerObjectId: "modal-obj-123",
        sessionId: "test-session",
        reason: "final_preservation",
        intent: "preserve",
        deadlineAtMs,
      });
      expect(client.stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        undefined
      );
    } finally {
      vi.useRealTimers();
    }
  });
  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "modal");

      expect(provider.name).toBe("modal");
      expect(provider.capabilities.supportsSnapshots).toBe(true);
      expect(provider.capabilities.supportsRestore).toBe(true);
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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

        try {
          await provider.createSandbox(testConfig);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("transient");
        }
      });

      it("classifies typed request deadline errors as transient", async () => {
        const client = createMockModalClient({
          createSandbox: vi.fn(async () => {
            throw new RequestDeadlineError("Modal", "createSandbox", 30_000);
          }),
        });
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        const provider = new ModalSandboxProvider(client, "modal");

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
        createdAt: 1234567890,
        vncUrl: "https://vnc.test",
        vncPassword: "vnc-pw",
      };

      const client = createMockModalClient({
        createSandbox: vi.fn(async () => expectedResult),
      });
      const provider = new ModalSandboxProvider(client, "modal");

      const result = await provider.createSandbox({ ...testConfig, vncEnabled: true });

      expect(result.sandboxId).toBe("sandbox-abc");
      expect(result.providerObjectId).toBe("modal-obj-xyz");
      expect(result.createdAt).toBe(1234567890);
      expect(result).toMatchObject({
        vncAccess: { url: "https://vnc.test", password: "vnc-pw" },
      });
      expect(client.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ vncEnabled: true }),
        undefined
      );
    });

    it("reports a missing prebuilt image explicitly", async () => {
      const error = new ModalApiError("Repository image unavailable", 410);
      const client = createMockModalClient({
        createSandbox: vi.fn(async () => {
          throw error;
        }),
      });

      await expect(
        new ModalSandboxProvider(client, "modal").createSandbox({
          ...testConfig,
          prebuiltImageId: "im-missing",
        })
      ).rejects.toEqual(
        expect.objectContaining({
          name: "PrebuiltImageUnavailableError",
          errorType: "permanent",
          cause: error,
        })
      );
    });

    it("keeps unrelated prebuilt spawn failures as generic provider errors", async () => {
      const client = createMockModalClient({
        createSandbox: vi.fn(async () => {
          throw new ModalApiError("Quota exceeded", 429);
        }),
      });

      const error = await new ModalSandboxProvider(client, "modal")
        .createSandbox({ ...testConfig, prebuiltImageId: "im-valid" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxProviderError);
      expect(error).not.toBeInstanceOf(PrebuiltImageUnavailableError);
    });
  });

  describe("image builds", () => {
    it("binds a created image-build sandbox before starting it", async () => {
      const client = createMockModalClient();
      const provider = new ModalSandboxProvider(client, "modal");
      const correlation = { request_id: "request-1", trace_id: "trace-1" };
      const onProviderSessionCreated = vi.fn(async () => undefined);

      await provider.triggerImageBuild({
        buildId: "build-123",
        scopeKind: "repo",
        scopeId: "acme/repo",
        repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
        cloneToken: "clone-token",
        userEnvVars: { FOO: "bar" },
        buildExecutionTimeoutSeconds: 1800,
        providerSessionTimeoutSeconds: 2400,
        callbackUrl: "https://worker.test/image-builds/build-complete",
        failureCallbackUrl: "https://worker.test/image-builds/build-failed",
        callbackToken: "callback-token",
        onProviderSessionCreated,
        correlation,
      });

      expect(client.createImageBuildSandbox).toHaveBeenCalledWith(
        {
          sandboxBackend: "modal",
          resources: undefined,
          scopeKind: "repo",
          scopeId: "acme/repo",
          buildId: "build-123",
          repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
          cloneToken: "clone-token",
          callbackUrl: "https://worker.test/image-builds/build-complete",
          failureCallbackUrl: "https://worker.test/image-builds/build-failed",
          userEnvVars: { FOO: "bar" },
          buildExecutionTimeoutSeconds: 1800,
          providerSessionTimeoutSeconds: 2400,
        },
        correlation
      );
      expect(onProviderSessionCreated).toHaveBeenCalledWith("modal-session-123");
      expect(client.startImageBuildSandbox).toHaveBeenCalledWith(
        {
          buildId: "build-123",
          providerSessionId: "modal-session-123",
          callbackToken: "callback-token",
          correlation,
        },
        correlation
      );
      expect(vi.mocked(client.createImageBuildSandbox).mock.invocationCallOrder[0]).toBeLessThan(
        onProviderSessionCreated.mock.invocationCallOrder[0]
      );
      expect(onProviderSessionCreated.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(client.startImageBuildSandbox).mock.invocationCallOrder[0]
      );
    });
  });

  describe("HTTP status handling", () => {
    it("confirms an invisible pending VM only after its materialization bound", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
        const createdAt = Date.now();
        const stopSandbox = vi.fn(async () => {
          throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
        });
        const provider = new ModalSandboxProvider(
          createMockModalClient({ stopSandbox }),
          "modal-vm"
        );
        const config = {
          sessionId: "test-session",
          providerObjectId: formatPendingVmReference("test-session", "generation"),
          reason: "respawn",
          intent: "destroy" as const,
          generationCreatedAtMs: createdAt,
        };
        await expect(provider.stopSandbox(config)).rejects.toThrow();
        vi.setSystemTime(createdAt + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS - 1);
        await expect(provider.stopSandbox(config)).rejects.toThrow();
        vi.setSystemTime(createdAt + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS);
        await expect(provider.stopSandbox(config)).resolves.toEqual({ success: true });
        await expect(
          provider.stopSandbox({
            ...config,
            providerObjectId: 'modal-vm-session:["test-session","generation"]',
          })
        ).resolves.toEqual({ success: true });
        await expect(
          provider.stopSandbox({ ...config, generationCreatedAtMs: undefined })
        ).rejects.toThrow();

        for (const error of [
          new ModalApiError("pending_reference_not_visible", 409, "other_conflict"),
          new ModalApiError("other conflict", 409),
          new ModalApiError("provider unavailable", 500),
          new Error("network failure"),
        ]) {
          stopSandbox.mockRejectedValueOnce(error);
          await expect(provider.stopSandbox(config)).rejects.toThrow();
        }
        stopSandbox.mockRejectedValueOnce(new ModalApiError("not found", 404));
        await expect(provider.stopSandbox(config)).resolves.toEqual({ success: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("classifies HTTP 502 from restoreFromSnapshot as transient", async () => {
      const client = createMockModalClient({
        restoreSandbox: vi.fn(async () => {
          throw new ModalApiError("Modal API error: 502 Bad Gateway", 502);
        }),
      });
      const provider = new ModalSandboxProvider(client, "modal");

      try {
        await provider.restoreFromSnapshot({
          snapshotImageId: "img-123",
          sessionId: "session-123",
          sandboxId: "sandbox-123",
          sandboxAuthToken: "token",
          harness: "opencode" as const,
          controlPlaneUrl: "https://test.com",
          repoOwner: "owner",
          repoName: "repo",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-5",
        });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies HTTP 401 from restoreFromSnapshot as permanent", async () => {
      const client = createMockModalClient({
        restoreSandbox: vi.fn(async () => {
          throw new ModalApiError("Modal API error: 401 Unauthorized", 401);
        }),
      });
      const provider = new ModalSandboxProvider(client, "modal");

      try {
        await provider.restoreFromSnapshot({
          snapshotImageId: "img-123",
          sessionId: "session-123",
          sandboxId: "sandbox-123",
          sandboxAuthToken: "token",
          harness: "opencode" as const,
          controlPlaneUrl: "https://test.com",
          repoOwner: "owner",
          repoName: "repo",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-5",
        });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies HTTP 503 from takeSnapshot as transient", async () => {
      const modalError = new ModalApiError("Modal API error: 503 Service Unavailable", 503);
      const client = createMockModalClient({
        snapshotSandbox: vi.fn(async () => {
          throw modalError;
        }),
      });
      const provider = new ModalSandboxProvider(client, "modal");

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
        expect(e).toMatchObject({
          message: "Snapshot failed with HTTP 503: Modal API error: 503 Service Unavailable",
          cause: modalError,
        });
      }
    });

    it("uses the identity-bound snapshot operation for image builds", async () => {
      const snapshotBuildSandbox = vi.fn(async () => ({
        imageId: "build-image-123",
      }));
      const provider = new ModalSandboxProvider(
        createMockModalClient({ snapshotBuildSandbox }),
        "modal"
      );

      await expect(
        provider.snapshotImageBuildSandbox({
          buildId: "imgb-1",
          providerSessionId: "modal-session-1",
        })
      ).resolves.toEqual({ success: true, imageId: "build-image-123" });
      expect(snapshotBuildSandbox).toHaveBeenCalledWith(
        {
          buildId: "imgb-1",
          providerSessionId: "modal-session-1",
        },
        undefined
      );
    });

    it("preserves Modal API errors from image-build snapshots as the provider cause", async () => {
      const modalError = new ModalApiError("Modal API error: 429 Too Many Requests", 429);
      const provider = new ModalSandboxProvider(
        createMockModalClient({
          snapshotBuildSandbox: vi.fn(async () => {
            throw modalError;
          }),
        }),
        "modal"
      );

      await expect(
        provider.snapshotImageBuildSandbox({
          buildId: "imgb-1",
          providerSessionId: "modal-session-1",
        })
      ).rejects.toMatchObject({
        cause: modalError,
      });
    });

    it.each([undefined, "restore-token"])(
      "forwards restore identity with legacy token %s",
      async (legacyToken) => {
        const client = createMockModalClient({
          restoreSandbox: vi.fn(async () => ({
            sandboxId: "restored-sandbox-123",
            modalObjectId: "new-modal-obj-456",
            vncUrl: "https://vnc.test",
            vncPassword: "vnc-pw",
          })),
        });
        const provider = new ModalSandboxProvider(client, "modal");

        const result = await provider.restoreFromSnapshot({
          snapshotImageId: "img-123",
          cloneCredentials: {
            identity: { host: "github.com", username: "x-access-token" },
            ...(legacyToken ? { legacyToken } : {}),
          },
          sessionId: "session-123",
          sandboxId: "sandbox-123",
          sandboxAuthToken: "token",
          harness: "opencode" as const,
          controlPlaneUrl: "https://test.com",
          repoOwner: "owner",
          repoName: "repo",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-5",
          vncEnabled: true,
        });

        expect(result.success).toBe(true);
        expect(result.sandboxId).toBe("restored-sandbox-123");
        expect(result.providerObjectId).toBe("new-modal-obj-456");
        expect(result).toMatchObject({
          vncAccess: { url: "https://vnc.test", password: "vnc-pw" },
        });
        expect(client.restoreSandbox).toHaveBeenCalledWith(
          expect.objectContaining({
            vncEnabled: true,
            cloneCredentials: {
              identity: { host: "github.com", username: "x-access-token" },
              ...(legacyToken ? { legacyToken } : {}),
            },
          }),
          undefined
        );
      }
    );
  });
});
