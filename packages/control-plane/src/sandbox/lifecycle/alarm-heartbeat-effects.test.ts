import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import type { SnapshotResult } from "../provider";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  createAlarmFixture,
  createMockSandbox,
  createMockProvider,
  noLifetime,
} from "./test-helpers";

async function beginReadyConfirmation(
  h: ReturnType<typeof createAlarmFixture>,
  sandbox: ReturnType<typeof createMockSandbox>
): Promise<void> {
  expect(await h.manager.handleAlarm()).toBe("no_action");
  expect(sandbox.status).toBe("ready");
  expect(sandbox.heartbeat_confirmation_heartbeat).toBe(sandbox.last_heartbeat);
  expect(sandbox.heartbeat_confirmation_deadline).toBeGreaterThan(Date.now());
  expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
  if (h.provider.stopSandbox) expect(h.provider.stopSandbox).not.toHaveBeenCalled();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(sandbox.heartbeat_confirmation_deadline!);
}

describe("heartbeat alarm effects", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("holds the first 153173ms observation to one absolute deadline, despite earlier alarms", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const sandbox = createMockSandbox({
      status: "ready",
      last_heartbeat: Date.now() - 153_173,
      active_socket_id: "socket-1",
      auth_token_hash: "live",
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox,
      })
    );
    expect(await h.manager.handleAlarm()).toBe("no_action");
    expect(sandbox.heartbeat_confirmation_deadline).toBe(1_060_000);
    expect(sandbox).toMatchObject({
      status: "ready",
      active_socket_id: "socket-1",
      auth_token_hash: "live",
    });
    expect(stopSandbox).not.toHaveBeenCalled();
    vi.setSystemTime(1_030_000);
    expect(await h.manager.handleAlarm()).toBe("no_action");
    expect(sandbox.heartbeat_confirmation_deadline).toBe(1_060_000);
    vi.setSystemTime(1_060_000);
    expect(await h.manager.handleAlarm()).toEqual({
      kind: "heartbeat_lost",
      reason: "The sandbox stopped responding.",
    });
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(sandbox.status).toBe("stale");
  });

  it("does not claim a recovered heartbeat after a deferred unmanaged shutdown", async () => {
    const sandbox = createMockSandbox({ status: "ready", last_heartbeat: Date.now() - 153_173 });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox,
      })
    );
    await beginReadyConfirmation(h, sandbox);
    // A managed provider can yield before telling the legacy path it is unmanaged.
    h.shutdown.requestShutdown = vi.fn(async () => {
      sandbox.last_heartbeat = Date.now();
      sandbox.heartbeat_confirmation_heartbeat = null;
      sandbox.heartbeat_confirmation_deadline = null;
      return "unmanaged" as const;
    });
    // Exercise the unmanaged fallback's post-await conditional claim directly.
    h.provider.capabilities.snapshotRequiresShutdown = true;
    expect(await h.manager.handleAlarm()).toBe("no_action");
    expect(sandbox.status).toBe("ready");
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.shutdown.requestShutdown).toHaveBeenCalledOnce();
  });

  it.each(["replacement", "shutdown owner"] as const)(
    "does not run legacy preservation when a %s wins during shutdown handoff",
    async (winner) => {
      const sandbox = createMockSandbox({ status: "ready", last_heartbeat: Date.now() - 153_173 });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, snapshotRequiresShutdown: true },
          stopSandbox,
        })
      );
      await beginReadyConfirmation(h, sandbox);
      h.shutdown.requestShutdown = vi.fn(async () => {
        if (winner === "replacement") {
          sandbox.modal_sandbox_id = "replacement";
          sandbox.created_at += 1;
        } else {
          h.shutdown.isHolding = () => true;
        }
        return "unmanaged" as const;
      });
      expect(await h.manager.handleAlarm()).toBe("no_action");
      expect(sandbox.status).toBe("ready");
      expect(stopSandbox).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    }
  );

  it.each([
    { status: "spawning", resumable: false, explicitStop: true },
    { status: "spawning", resumable: true, explicitStop: true },
    { status: "connecting", resumable: false, explicitStop: true },
    { status: "connecting", resumable: true, explicitStop: true },
    { status: "ready", resumable: true, explicitStop: true },
    { status: "connecting", resumable: false, explicitStop: false },
  ] as const)(
    "retires stale $status without snapshot or shutdown (resumable=$resumable, explicitStop=$explicitStop)",
    async ({ status, resumable, explicitStop }) => {
      const sandbox = createMockSandbox({
        status,
        last_heartbeat: Date.now() - DEFAULT_LIFECYCLE_CONFIG.heartbeat.timeoutMs - 1,
      });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: explicitStop, supportsPersistentResume: resumable },
          stopSandbox,
        })
      );

      if (status === "ready") await beginReadyConfirmation(h, sandbox);
      await expect(h.manager.handleAlarm()).resolves.toEqual(
        status === "ready"
          ? { kind: "heartbeat_lost", reason: "The sandbox stopped responding." }
          : "sandbox_terminated"
      );

      if (explicitStop) {
        expect(stopSandbox).toHaveBeenCalledExactlyOnceWith({
          providerObjectId: sandbox.modal_object_id,
          sessionId: "test-session",
          reason: "heartbeat_timeout",
          intent: resumable ? "preserve" : "destroy",
          signal: undefined,
          generationCreatedAtMs: sandbox.created_at,
        });
      } else {
        expect(stopSandbox).not.toHaveBeenCalled();
      }
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Heartbeat stale"
      );
      expect(sandbox.status).toBe("stale");
      expect(sandbox.spawn_failure_count).toBe(status === "ready" ? 0 : 1);
      expect(h.storage.incrementCircuitBreakerFailure).toHaveBeenCalledTimes(
        status === "ready" ? 0 : 1
      );
      expect(h.storage.resetCircuitBreaker).not.toHaveBeenCalled();
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "stale" });
    }
  );

  it("saves a stale sandbox whose snapshots stop it without its runtime, then stops it", async () => {
    const sandbox = createMockSandbox({ status: "ready", last_heartbeat: Date.now() - 100_000 });
    const takeSnapshot = vi.fn(async () => ({
      success: true,
      imageId: "heartbeat-image",
      sourceStopped: false,
    }));
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, snapshotRequiresShutdown: true },
        takeSnapshot,
        stopSandbox,
      })
    );

    await beginReadyConfirmation(h, sandbox);
    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(takeSnapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "heartbeat_timeout" })
    );
    expect(stopSandbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "heartbeat_timeout", intent: "destroy" })
    );
    expect(takeSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      stopSandbox.mock.invocationCallOrder[0]
    );
    // No graceful drain: the runtime is never asked to prepare or shut down.
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
    expect(sandbox.snapshot_image_id).toBe("heartbeat-image");
    expect(sandbox.status).toBe("stopped");
    expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "stale" });
    expect(h.broadcaster.messages).toContainEqual(
      expect.objectContaining({
        type: "sandbox_preservation",
        preservation: expect.objectContaining({ phase: "saved", continuationPaused: true }),
      })
    );
  });

  it("keeps a stale sandbox for another attempt when saving it without its runtime fails", async () => {
    const sandbox = createMockSandbox({ status: "ready", last_heartbeat: Date.now() - 100_000 });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, snapshotRequiresShutdown: true },
        takeSnapshot: vi.fn(async () => {
          throw new Error("guest unresponsive");
        }),
        stopSandbox,
      })
    );

    await beginReadyConfirmation(h, sandbox);
    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("stale");
    expect(h.broadcaster.messages).toContainEqual(
      expect.objectContaining({
        type: "sandbox_preservation",
        preservation: expect.objectContaining({
          phase: "unknown",
          availableRecoveryActions: ["retry"],
          discardAvailable: true,
        }),
      })
    );
    expect(h.manager.onRefusedReconnect()).toBe("retry");
  });

  it("does not await a heartbeat snapshot when the provider cannot explicitly stop", async () => {
    const sandbox = createMockSandbox({ last_heartbeat: Date.now() - 100_000 });
    let releaseSnapshot!: (result: SnapshotResult) => void;
    const takeSnapshot = vi.fn(
      () =>
        new Promise<SnapshotResult>((resolve) => {
          releaseSnapshot = resolve;
        })
    );
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: false },
        takeSnapshot,
        stopSandbox,
      })
    );
    const snapshot = vi.spyOn(h.manager, "triggerSnapshot");
    await beginReadyConfirmation(h, sandbox);
    const pending = h.manager.handleAlarm();

    try {
      await expect(pending).resolves.toEqual({
        kind: "heartbeat_lost",
        reason: "The sandbox stopped responding.",
      });
      expect(takeSnapshot).toHaveBeenCalledOnce();
      expect(stopSandbox).not.toHaveBeenCalled();
      expect(sandbox.snapshot_image_id).toBeNull();
      expect(h.wsManager.sendToSandbox).toHaveBeenCalledExactlyOnceWith({ type: "shutdown" });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Heartbeat stale"
      );
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "stale" });
    } finally {
      releaseSnapshot({ success: true, imageId: "late-snapshot" });
      await snapshot.mock.results[0].value;
      await pending;
    }

    expect(sandbox.snapshot_image_id).toBe("late-snapshot");
    expect(sandbox.status).toBe("stale");
    expect(sandbox.spawn_failure_count).toBe(0);
  });

  describe.each(["rejected", "unsuccessful"] as const)("%s provider stop", (failure) => {
    it.each([
      { status: "connecting", resumable: false },
      { status: "connecting", resumable: true },
      { status: "ready", resumable: false },
      { status: "ready", resumable: true },
    ] as const)("still retires $status (resumable=$resumable)", async ({ status, resumable }) => {
      const sandbox = createMockSandbox({
        status,
        last_heartbeat: Date.now() - 100_000,
        code_server_url: "https://code.test",
      });
      const stopSandbox = vi.fn(async () => {
        if (failure === "rejected") throw new Error("provider stop unavailable");
        return { success: false, error: "provider stop unavailable" };
      });
      const stopLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: resumable },
          stopSandbox,
        })
      );

      if (status === "ready") await beginReadyConfirmation(h, sandbox);
      await expect(h.manager.handleAlarm()).resolves.toEqual(
        status === "ready"
          ? { kind: "heartbeat_lost", reason: "The sandbox stopped responding." }
          : "sandbox_terminated"
      );

      expect(stopSandbox).toHaveBeenCalledOnce();
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "heartbeat_timeout",
          intent: resumable ? "preserve" : "destroy",
        })
      );
      expect(stopLog).toHaveBeenCalledWith(
        expect.stringContaining('"error":"provider stop unavailable"')
      );
      expect(sandbox.code_server_url).toBeNull();
      expect(sandbox.status).toBe("stale");
      expect(h.manager.isSpawning()).toBe(false);
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "stale" });
      expect(h.alarmScheduler.schedule).toHaveBeenCalledTimes(status === "ready" ? 1 : 0);
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Heartbeat stale"
      );
      expect(h.provider.takeSnapshot).toHaveBeenCalledTimes(
        status === "ready" && !resumable ? 1 : 0
      );
      expect(h.wsManager.sendToSandbox).toHaveBeenCalledTimes(
        status === "ready" && !resumable ? 1 : 0
      );
    });
  });

  it.each(["spawn", "restore"] as const)(
    "%s does not inherit a stopped sandbox's heartbeat when an alarm fires during startup",
    async (kind) => {
      const sandbox = createMockSandbox({
        status: "stopped",
        created_at: Date.now() - 4_000_000,
        last_heartbeat: Date.now() - 4_000_000,
        snapshot_image_id: kind === "restore" ? "snapshot-old" : null,
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const h = createAlarmFixture(sandbox);
      const checkStartup = async () => {
        expect(sandbox.status).toBe("spawning");
        expect(await h.manager.handleAlarm()).toBe("no_action");
        expect(sandbox.status).toBe("spawning");
      };
      vi.spyOn(h.provider, "createSandbox").mockImplementation(async (config) => {
        await checkStartup();
        return {
          sandboxId: config.sandboxId,
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        };
      });
      vi.spyOn(h.provider, "restoreFromSnapshot").mockImplementation(async (config) => {
        await checkStartup();
        return { success: true, sandboxId: config.sandboxId, lifetime: noLifetime() };
      });

      await h.manager.spawnSandbox();

      expect(
        kind === "restore" ? h.provider.restoreFromSnapshot : h.provider.createSandbox
      ).toHaveBeenCalledOnce();
      expect(sandbox.status).toBe("connecting");
      expect(sandbox.last_heartbeat).toBeNull();
      expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    }
  );
});
