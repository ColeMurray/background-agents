import { describe, expect, it, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { createAlarmHandler } from "../../session/alarm/handler";
import { SandboxLaunchRejectedError } from "../provider";
import { ModalSandboxProvider } from "../providers/modal-provider";
import type { ModalClient } from "../client";
import { createAlarmFixture, createMockProvider, createMockSandbox } from "./test-helpers";

describe("rejected provider allocation", () => {
  it.each(["stopped", "stale"] as const)(
    "preserves %s when a cancelled launch is later rejected",
    async (status) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox: async () => {
          throw new Error("unavailable");
        },
        createSandbox: async () => {
          sandbox.status = status;
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
      expect(fixture.storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
    }
  );
  it("retains a pre-launch VM reference when the response is lost after bridge connection", async () => {
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const client = {
      createSandbox: vi.fn(async () => {
        expect(sandbox.modal_object_id).toContain("modal-vm-session:");
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
    let finishStop!: () => void;
    const client = {
      createSandbox: vi.fn(async () => {
        sandbox.status = "ready";
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
          })
      ),
    };
    const fixture = createAlarmFixture(
      sandbox,
      new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm")
    );
    const spawning = fixture.manager.spawnSandbox();
    try {
      await vi.waitFor(() => expect(client.stopSandbox).toHaveBeenCalledOnce());
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.auth_token_hash).toBe("");
      expect(sandbox.modal_object_id).toBe("sb-rejected");
      expect(fixture.wsManager.detachSandboxWebSocket).toHaveBeenCalled();
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
        preserveBeforeWatchdogs: () => restarted.manager.handleShutdownAlarm(),
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
    }
  );
});
