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

describe("heartbeat alarm effects", () => {
  afterEach(() => vi.restoreAllMocks());

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

      await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

      if (explicitStop) {
        expect(stopSandbox).toHaveBeenCalledExactlyOnceWith({
          providerObjectId: sandbox.modal_object_id,
          sessionId: "test-session",
          reason: "heartbeat_timeout",
          intent: resumable ? "preserve" : "destroy",
          signal: undefined,
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
    const pending = h.manager.handleAlarm();

    try {
      await expect(pending).resolves.toBe("sandbox_terminated");
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

      await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

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
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
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
