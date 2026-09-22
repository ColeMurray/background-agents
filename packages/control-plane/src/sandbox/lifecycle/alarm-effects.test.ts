import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import { createAlarmFixture, createMockSandbox, createMockProvider } from "./test-helpers";

describe("cross-path alarm effects", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["heartbeat", "inactivity"] as const)(
    "%s publishes retirement before awaiting snapshot, then uses its required stop/shutdown order",
    async (trigger) => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        last_heartbeat: trigger === "heartbeat" ? now - 100_000 : now,
        last_activity: now - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
        code_server_url: "https://code.test",
        code_server_password: "code-secret",
        vnc_url: "https://vnc.test",
        vnc_password: "vnc-secret",
        ttyd_url: "https://terminal.test",
        ttyd_token: "terminal-secret",
        tunnel_urls: '{"3000":"https://preview.test"}',
      });
      const order: string[] = [];
      let releaseSnapshot!: () => void;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      const takeSnapshot = vi.fn(async () => {
        order.push("snapshot:start");
        await snapshotGate;
        order.push("snapshot:complete");
        return { success: true, imageId: "snapshot-complete" };
      });
      let releaseStop!: () => void;
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const stopSandbox = vi.fn(async () => {
        await stopGate;
        order.push("stop");
        return { success: true };
      });
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: false },
          takeSnapshot,
          stopSandbox,
        })
      );
      vi.mocked(h.wsManager.sendToSandbox).mockImplementation((message) => {
        expect(message).toEqual({ type: "shutdown" });
        order.push("shutdown");
        return true;
      });
      vi.mocked(h.wsManager.detachSandboxWebSocket).mockImplementation(() => {
        order.push("detach");
      });
      const settled = vi.fn();
      const pending = h.manager.handleAlarm().then((result) => {
        settled();
        return result;
      });

      try {
        await vi.waitFor(() => expect(takeSnapshot).toHaveBeenCalledOnce());
        expect(settled).not.toHaveBeenCalled();
        const status = trigger === "heartbeat" ? "stale" : "stopped";
        expect(sandbox).toMatchObject({
          status,
          code_server_url: null,
          code_server_password: null,
          vnc_url: null,
          vnc_password: null,
          ttyd_url: null,
          ttyd_token: null,
          tunnel_urls: null,
        });
        expect(h.broadcaster.messages).toEqual([
          { type: "sandbox_access_changed" },
          { type: "sandbox_status", status },
        ]);
        expect(order).toEqual(["snapshot:start"]);
        expect(sandbox.snapshot_image_id).toBeNull();
        expect(stopSandbox).not.toHaveBeenCalled();
        expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
        expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();

        releaseSnapshot();
        await vi.waitFor(() => expect(stopSandbox).toHaveBeenCalledOnce());
        expect(settled).not.toHaveBeenCalled();
        expect(h.wsManager.sendToSandbox).toHaveBeenCalledTimes(trigger === "heartbeat" ? 0 : 1);
        expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
        expect(order).toEqual([
          "snapshot:start",
          "snapshot:complete",
          ...(trigger === "inactivity" ? ["shutdown"] : []),
        ]);
      } finally {
        releaseSnapshot();
        releaseStop();
        await pending;
      }

      await expect(pending).resolves.toBe("sandbox_terminated");
      expect(takeSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: sandbox.modal_object_id,
          reason: `${trigger}_timeout`,
        })
      );
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: sandbox.modal_object_id,
          reason: `${trigger}_timeout`,
          intent: "destroy",
        })
      );
      expect(order).toEqual([
        "snapshot:start",
        "snapshot:complete",
        ...(trigger === "heartbeat" ? ["stop", "shutdown"] : ["shutdown", "stop"]),
        "detach",
      ]);
      expect(sandbox.snapshot_image_id).toBe("snapshot-complete");
      expect(sandbox.status).toBe(trigger === "heartbeat" ? "stale" : "stopped");
      expect(sandbox.spawn_failure_count).toBe(0);
    }
  );

  it.each(["heartbeat", "inactivity"] as const)(
    "does not stop or detach a replacement admitted after %s checkpoint completion",
    async (trigger) => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        last_heartbeat: trigger === "heartbeat" ? now - 100_000 : now - 10_000,
        last_activity:
          trigger === "inactivity" ? now - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1 : now,
      });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: false },
          stopSandbox,
        }),
        0,
        async () => {
          sandbox.modal_sandbox_id = "replacement-sandbox";
          sandbox.modal_object_id = "replacement-provider-object";
          sandbox.created_at += 1;
          sandbox.status = "connecting";
        }
      );

      await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

      expect(stopSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.sendToSandbox).not.toHaveBeenCalledWith({ type: "shutdown" });
      expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      expect(sandbox).toMatchObject({
        modal_sandbox_id: "replacement-sandbox",
        modal_object_id: "replacement-provider-object",
        status: "connecting",
      });
    }
  );

  it.each(["heartbeat", "budget"] as const)(
    "continues the failure streak and blocks replacement after a long %s boot",
    async (trigger) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000_000);
      const now = Date.now();
      const createdAt =
        now -
        Math.max(
          DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.windowMs,
          DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs
        ) -
        1;
      const sandbox = createMockSandbox({
        status: "connecting",
        created_at: createdAt,
        last_heartbeat: trigger === "heartbeat" ? now - 100_000 : now,
        spawn_failure_count: 2,
        last_spawn_failure: createdAt,
      });
      const h = createAlarmFixture(sandbox);

      const result = await h.manager.handleAlarm();

      expect(result).toEqual(
        trigger === "heartbeat"
          ? "sandbox_terminated"
          : { kind: "boot_budget_exceeded", reason: sandbox.last_spawn_error }
      );
      expect(sandbox.spawn_failure_count).toBe(3);
      expect(sandbox.last_spawn_failure).toBe(now);
      expect(h.storage.resetCircuitBreaker).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();

      await h.manager.spawnSandbox();

      expect(h.storage.updateSandboxForSpawn).not.toHaveBeenCalled();
      expect(h.provider.createSandbox).not.toHaveBeenCalled();
      expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(h.broadcaster.messages).toContainEqual(
        expect.objectContaining({
          type: "sandbox_error",
          error: expect.stringContaining("temporarily disabled after 3 failures"),
        })
      );
    }
  );

  it.each([null, "stopped", "stale", "failed"] as const)(
    "does nothing for a %s row",
    async (status) => {
      const sandbox =
        status === null
          ? null
          : createMockSandbox({
              status,
              created_at: 1,
              last_activity: 1,
              last_heartbeat: 1,
              code_server_url: "https://code.test",
            });
      const original = sandbox && { ...sandbox };
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
      );

      await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

      expect(sandbox).toEqual(original);
      expect(h.storage.calls).toEqual(["getSandbox"]);
      expect(h.broadcaster.messages).toEqual([]);
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.alarmScheduler.cancel).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(stopSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      path: "connecting watchdog",
      overrides: {
        status: "connecting" as const,
        created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs - 10_000,
        last_heartbeat: null,
      },
      reason: "connecting_timeout",
    },
    {
      path: "boot budget",
      overrides: {
        status: "connecting" as const,
        created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs - 10_000,
        last_heartbeat: Date.now() - 1_000,
      },
      reason: "boot_budget_exceeded",
    },
  ])(
    "$path stops the generation it observed, not a replacement installed mid-alarm",
    async ({ overrides, reason }) => {
      // A replacement spawn can install a new row while the alarm is still
      // running. Re-reading the row for the provider handle at stop time would
      // destroy that replacement instead of the generation that timed out.
      const doomed = createMockSandbox({ ...overrides, modal_object_id: "modal-obj-doomed" });
      const replacement = createMockSandbox({
        status: "connecting",
        modal_sandbox_id: "sandbox-replacement",
        modal_object_id: "modal-obj-replacement",
        created_at: Date.now(),
        last_heartbeat: null,
      });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        doomed,
        createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
      );
      let reads = 0;
      vi.mocked(h.storage.getSandbox).mockImplementation(() =>
        ++reads === 1 ? doomed : replacement
      );

      await h.manager.handleAlarm();

      expect(stopSandbox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerObjectId: "modal-obj-doomed", reason })
      );
      expect(replacement.status).toBe("connecting");
    }
  );
});
