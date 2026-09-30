import { describe, expect, it, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { createAlarmHandler } from "../../session/alarm/handler";
import { SandboxLaunchRejectedError } from "../provider";
import { ModalSandboxProvider } from "../providers/modal-provider";
import { ModalApiError, type ModalClient } from "../client";
import { formatPendingVmReference } from "../providers/pending-vm-reference";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import { createAlarmFixture, createMockProvider, createMockSandbox } from "./test-helpers";

describe("rejected provider allocation", () => {
  it.each(["failed", "stopped", "stale"] as const)(
    "preserves %s when a terminalized launch is later rejected",
    async (status) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox: async () => {
          throw new Error("unavailable");
        },
        createSandbox: async () => {
          sandbox.status = status;
          sandbox.last_spawn_error = "existing terminal error";
          sandbox.last_spawn_error_at = 123;
          throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
        },
      });
      const fixture = createAlarmFixture(sandbox, provider);
      await fixture.manager.spawnSandbox();
      expect(sandbox.status).toBe(status);
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.modal_object_id).toBe("sb-rejected");
      expect(fixture.broadcaster.broadcast).not.toHaveBeenCalledWith({
        type: "sandbox_status",
        status: "failed",
      });
      expect(fixture.broadcaster.broadcast).not.toHaveBeenCalledWith({
        type: "sandbox_error",
        error: "incompatible",
      });
      expect(sandbox.last_spawn_error).toBe("existing terminal error");
      expect(sandbox.last_spawn_error_at).toBe(123);
      expect(fixture.storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
    }
  );
  it("retains a pre-launch VM reference when the response is lost after bridge connection", async () => {
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const client = {
      createSandbox: vi.fn(async () => {
        expect(sandbox.modal_object_id).toContain('modal-vm-session:["');
        sandbox.status = "ready";
        vi.mocked(fixture.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
        throw new Error("response lost");
      }),
    };
    const provider = new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm");
    const fixture = createAlarmFixture(sandbox, provider);
    await fixture.manager.spawnSandbox();
    expect(sandbox.status).toBe("ready");
    expect(sandbox.modal_object_id).toContain(sandbox.modal_sandbox_id);
    const restarted = createAlarmFixture(sandbox, provider);
    expect(restarted.storage.getSandbox()?.modal_object_id).toBe(sandbox.modal_object_id);
  });
  it("fences an early connected generation before waiting for mismatch cleanup", async () => {
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    let beginStop!: () => void;
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => (beginStop = resolve));
    const client = {
      createSandbox: vi.fn(async () => {
        sandbox.status = "ready";
        sandbox.active_socket_id = "early-socket";
        sandbox.code_server_url = "https://early-access.test";
        sandbox.code_server_password = "early-secret";
        vi.mocked(fixture.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
        return {
          sandboxId: sandbox.modal_sandbox_id,
          modalObjectId: "sb-rejected",
          sandboxBackend: "modal",
          createdAt: 1,
        };
      }),
      stopSandbox: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
            beginStop();
          })
      ),
    };
    const fixture = createAlarmFixture(
      sandbox,
      new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm")
    );
    const spawning = fixture.manager.spawnSandbox();
    try {
      await stopping;
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.auth_token_hash).toBe("");
      expect(sandbox.active_socket_id).toBe("");
      expect(sandbox.modal_object_id).toBe("sb-rejected");
      expect(fixture.wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(
        1008,
        "Provider allocation rejected"
      );
      expect(sandbox.code_server_url).toBeNull();
      expect(sandbox.code_server_password).toBeNull();
      expect(
        vi.mocked(fixture.storage.rejectProviderStartup).mock.invocationCallOrder[0]
      ).toBeLessThan(
        vi.mocked(fixture.wsManager.detachSandboxWebSocket).mock.invocationCallOrder[0]
      );
      expect(
        vi.mocked(fixture.wsManager.detachSandboxWebSocket).mock.invocationCallOrder[0]
      ).toBeLessThan(vi.mocked(fixture.storage.clearSandboxAccess).mock.invocationCallOrder[0]);
      expect(fixture.storage.incrementCircuitBreakerFailure).toHaveBeenCalledOnce();
      expect(
        fixture.broadcaster.messages.filter(
          (message) => "type" in message && message.type === "sandbox_error"
        )
      ).toEqual([{ type: "sandbox_error", error: expect.any(String) }]);
      expect(fixture.manager.mayProcessQueuedWork()).toBe(false);
    } finally {
      finishStop();
      await spawning;
    }
  });
  it.each([
    [false, "sb-rejected"],
    [true, "sb-rejected"],
    ["expired", "sb-rejected"],
    [false, null],
    [true, null],
    ["expired", null],
  ] as const)(
    "retains cleanup identity and fences the rejected generation (early bridge=%s, cleanup handle=%s)",
    async (earlyBridge, cleanupHandle) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox: async () => {
          throw new Error("retirement unavailable");
        },
        createSandbox: async () => {
          if (earlyBridge) {
            sandbox.status = earlyBridge === "expired" ? "failed" : "connecting";
            if (earlyBridge === "expired") sandbox.fenced = 1;
            vi.mocked(fixture.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
          }
          throw new SandboxLaunchRejectedError("incompatible allocation", cleanupHandle);
        },
      });
      const fixture = createAlarmFixture(sandbox, provider);
      await fixture.manager.spawnSandbox();
      expect(sandbox.status).toBe("failed");
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.auth_token_hash).toBe("");
      expect(sandbox.modal_object_id).toBe(cleanupHandle);
      expect(fixture.wsManager.detachSandboxWebSocket).toHaveBeenCalled();
    }
  );
  it("retains rejected cleanup responsibility across restart and failed retirement", async () => {
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const provider = createMockProvider({
      capabilities: { supportsExplicitStop: true },
      createSandbox: vi.fn(async () => {
        throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
      }),
      stopSandbox: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    await createAlarmFixture(sandbox, provider).manager.spawnSandbox();
    const rejectedGeneration = sandbox.modal_sandbox_id;
    const restarted = createAlarmFixture(sandbox, provider);
    await restarted.manager.spawnSandbox();
    await restarted.manager.spawnSandbox();
    expect(sandbox.modal_object_id).toBe("sb-rejected");
    expect(sandbox.modal_sandbox_id).toBe(rejectedGeneration);
    expect(sandbox.fenced).toBe(1);
    expect(provider.createSandbox).toHaveBeenCalledTimes(1);
  });
  it.each(["new generation", "new timestamp", "new handle"] as const)(
    "rearms cleanup before stop and does not clear a %s after the old stop succeeds",
    async (replacement) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      let beginStop!: () => void;
      let releaseStop!: () => void;
      const stopping = new Promise<void>((resolve) => (beginStop = resolve));
      const gate = new Promise<void>((resolve) => (releaseStop = resolve));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        createSandbox: async () => {
          throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
        },
        stopSandbox: vi.fn(async () => {
          beginStop();
          await gate;
          return { success: true };
        }),
      });
      const fixture = createAlarmFixture(sandbox, provider);
      const spawning = fixture.manager.spawnSandbox();
      let replacementRow!: typeof sandbox;
      try {
        await stopping;
        expect(sandbox).toMatchObject({
          status: "failed",
          startup_rejected: 1,
          fenced: 1,
          modal_object_id: "sb-rejected",
        });
        expect(fixture.alarmScheduler.schedule).toHaveBeenCalledTimes(2);
        expect(vi.mocked(fixture.alarmScheduler.schedule).mock.invocationCallOrder[1]).toBeLessThan(
          vi.mocked(provider.stopSandbox!).mock.invocationCallOrder[0]
        );
        expect(provider.stopSandbox).toHaveBeenCalledExactlyOnceWith({
          providerObjectId: "sb-rejected",
          sessionId: "test-session",
          reason: "startup_superseded",
          intent: "destroy",
          signal: expect.any(AbortSignal),
          generationCreatedAtMs: undefined,
        });
        if (replacement === "new handle") sandbox.modal_object_id = "sb-newer";
        if (replacement === "new generation") {
          sandbox.modal_sandbox_id = "newer-generation";
        }
        if (replacement === "new timestamp") sandbox.created_at += 1;
        sandbox.status = "ready";
        sandbox.fenced = 0;
        sandbox.startup_rejected = 0;
        sandbox.code_server_url = "https://replacement.test";
        sandbox.code_server_password = "replacement-secret";
        sandbox.active_socket_id = "replacement-socket";
        replacementRow = structuredClone(sandbox);
      } finally {
        releaseStop();
        await spawning;
      }
      expect(sandbox).toEqual(replacementRow);
    }
  );
  it.each(["create", "restore"] as const)(
    "rearms %s cleanup through the assembled alarm handler even under a shutdown hold",
    async (launch) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      const stopSandbox = vi.fn().mockRejectedValue(new Error("provider unavailable"));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox,
        createSandbox: async () => {
          throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
        },
      });
      const first = createAlarmFixture(sandbox, provider);
      if (launch === "restore") {
        vi.mocked(first.shutdown.startupDecision).mockReturnValue({
          kind: "restore_snapshot",
          snapshotId: "im-existing",
          runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
        });
        provider.restoreFromSnapshot = provider.createSandbox as never;
      }
      await first.manager.spawnSandbox();
      const restarted = createAlarmFixture(sandbox, provider);
      vi.spyOn(restarted.shutdown, "handleAlarm").mockImplementation(
        async () => "hold_watchdogs" as never
      );
      const handler = createAlarmHandler({
        preserveBeforeWatchdogs: (allowCaptureRetry: boolean) =>
          restarted.manager.handleShutdownAlarm(allowCaptureRetry),
        lifecycleManager: restarted.manager,
        terminalMessageProjection: { flushPending: vi.fn(async () => {}) },
      } as never);
      await restarted.manager.rearmRejectedStartupCleanupAlarm();
      expect(restarted.alarmScheduler.schedule).toHaveBeenCalled();
      await handler.handle();
      expect(sandbox.modal_object_id).toBe("sb-rejected");
      stopSandbox.mockResolvedValue({ success: true });
      await handler.handle();
      expect(sandbox.modal_object_id).toBeNull();
      expect(sandbox.fenced).toBe(1);
      const cleaned = structuredClone(sandbox);
      const stopCount = stopSandbox.mock.calls.length;
      await handler.handle();
      expect(stopSandbox).toHaveBeenCalledTimes(stopCount);
      expect(sandbox).toEqual(cleaned);
    }
  );

  it.each(["rejected", "successful"] as const)(
    "retires a superseded %s allocation without changing the held successor",
    async (outcome) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      let replacementRow!: typeof sandbox;
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
        createSandbox: async () => {
          sandbox.modal_sandbox_id = "successor";
          sandbox.created_at += 1;
          sandbox.modal_object_id = "successor-handle";
          sandbox.status = "ready";
          sandbox.code_server_url = "https://successor.test";
          sandbox.code_server_password = "successor-secret";
          sandbox.active_socket_id = "successor-socket";
          replacementRow = structuredClone(sandbox);
          vi.spyOn(fixture.shutdown, "isHolding").mockReturnValue(true);
          if (outcome === "rejected")
            throw new SandboxLaunchRejectedError("incompatible", "old-handle");
          return {
            sandboxId: "old-generation",
            providerObjectId: "old-handle",
            createdAt: Date.now(),
            lifetime: { kind: "none", observedAtMs: Date.now() },
          };
        },
      });
      const fixture = createAlarmFixture(sandbox, provider);
      await fixture.manager.spawnSandbox();
      expect(provider.stopSandbox).toHaveBeenCalledExactlyOnceWith({
        providerObjectId: "old-handle",
        sessionId: "test-session",
        reason: "startup_superseded",
        intent: "destroy",
        signal: expect.any(AbortSignal),
        generationCreatedAtMs: undefined,
      });
      expect(sandbox).toEqual(replacementRow);
      expect(fixture.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      expect(fixture.storage.clearSandboxAccess).not.toHaveBeenCalled();
      expect(fixture.storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
      expect(fixture.broadcaster.messages).not.toContainEqual({
        type: "sandbox_status",
        status: "failed",
      });
      expect(fixture.broadcaster.messages).not.toContainEqual({
        type: "sandbox_error",
        error: "incompatible",
      });
    }
  );

  it.each(["capability disabled", "method absent"] as const)(
    "retains and rearms rejected cleanup without explicit stop (%s)",
    async (unsupported) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: unsupported !== "capability disabled" },
        stopSandbox: unsupported === "method absent" ? undefined : stopSandbox,
        createSandbox: async () => {
          throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
        },
      });
      const fixture = createAlarmFixture(sandbox, provider);
      await fixture.manager.spawnSandbox();
      await fixture.manager.handleShutdownAlarm();
      expect(sandbox.modal_object_id).toBe("sb-rejected");
      expect(fixture.alarmScheduler.schedule).toHaveBeenCalledTimes(3);
      expect(stopSandbox).not.toHaveBeenCalled();
    }
  );

  it("retains the rejected handle when the provider reports an unsuccessful stop", async () => {
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const provider = createMockProvider({
      capabilities: { supportsExplicitStop: true },
      stopSandbox: vi.fn(async () => ({ success: false, error: "retirement unconfirmed" })),
      createSandbox: async () => {
        throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
      },
    });
    const fixture = createAlarmFixture(sandbox, provider);
    await fixture.manager.spawnSandbox();
    await fixture.manager.handleShutdownAlarm();
    expect(sandbox.modal_object_id).toBe("sb-rejected");
    expect(provider.stopSandbox).toHaveBeenCalledTimes(2);
    expect(fixture.alarmScheduler.schedule).toHaveBeenCalledTimes(3);
  });

  it.each([0, PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS])(
    "does not reinterpret invisible pending cleanup as retirement based on row age (%s ms)",
    async (ageMs) => {
      const handle = formatPendingVmReference("test-session", "rejected-generation");
      const sandbox = createMockSandbox({
        status: "failed",
        fenced: 1,
        startup_rejected: 1,
        modal_sandbox_id: "rejected-generation",
        modal_object_id: handle,
        created_at: Date.now() - ageMs,
      });
      const client = {
        stopSandbox: vi.fn(async () => {
          throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
        }),
      };
      const provider = new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm");
      const stop = vi.spyOn(provider, "stopSandbox");
      const fixture = createAlarmFixture(sandbox, provider);
      expect(await fixture.manager.handleShutdownAlarm()).toBe("hold_watchdogs");
      expect(stop).toHaveBeenCalledWith({
        providerObjectId: handle,
        sessionId: "test-session",
        reason: "startup_superseded",
        intent: "destroy",
        signal: expect.any(AbortSignal),
        generationCreatedAtMs: undefined,
      });
      expect(sandbox.modal_object_id).toBe(handle);
      expect(fixture.alarmScheduler.schedule).toHaveBeenCalledOnce();
    }
  );
});
