import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import { createAlarmFixture, createMockSandbox, createMockProvider } from "./test-helpers";

describe("connecting watchdog effects", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["successful", "rejected", "unsuccessful"] as const)(
    "fails and fences before a %s provider stop, preserving the watchdog error",
    async (outcome) => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting",
        created_at: now - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs - 10_000,
        last_heartbeat: null,
        code_server_url: "https://code.test",
      });
      const stopSandbox = vi.fn(async () => {
        if (outcome === "rejected") throw new Error("provider stop unavailable");
        return { success: outcome === "successful", error: "provider stop unavailable" };
      });
      const stopLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
      );

      await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_failed");

      expect(stopSandbox).toHaveBeenCalledExactlyOnceWith({
        providerObjectId: sandbox.modal_object_id,
        sessionId: "test-session",
        reason: "connecting_timeout",
        intent: "destroy",
        signal: undefined,
      });
      expect(vi.mocked(h.storage.updateSandboxStatus).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(h.storage.fenceSandboxGeneration).mock.invocationCallOrder[0]
      );
      expect(vi.mocked(h.storage.fenceSandboxGeneration).mock.invocationCallOrder[0]).toBeLessThan(
        stopSandbox.mock.invocationCallOrder[0]
      );
      if (outcome !== "successful") {
        expect(stopLog).toHaveBeenCalledWith(
          expect.stringContaining('"error":"provider stop unavailable"')
        );
      }
      expect(sandbox.status).toBe("failed");
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.code_server_url).toBeNull();
      expect(sandbox.spawn_failure_count).toBe(1);
      expect(sandbox.last_spawn_failure).toBeGreaterThanOrEqual(now);
      expect(sandbox.last_spawn_error).toContain("failed to connect");
      expect(sandbox.last_spawn_error).not.toContain("provider stop unavailable");
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "failed" });
      expect(h.broadcaster.messages).toContainEqual({
        type: "sandbox_error",
        error: sandbox.last_spawn_error,
      });
      expect(h.manager.isSpawning()).toBe(false);
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    }
  );

  it("leaves a watchdog-failed generation unfenced without explicit stop so its late bridge may self-heal", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs - 10_000,
      last_heartbeat: null,
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({ capabilities: { supportsExplicitStop: false }, stopSandbox })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_failed");

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.storage.fenceSandboxGeneration).not.toHaveBeenCalled();
    expect(sandbox.fenced).toBe(0);
    expect(sandbox.spawn_failure_count).toBe(1);
    expect(sandbox.last_spawn_error).toContain("failed to connect");
    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
  });

  it("restarts the streak when this attempt began a full window after the previous failure", async () => {
    // The breaker window measures the idle gap before this attempt, not its duration.
    const createdAt = Date.now() - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs - 10_000;
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: createdAt,
      last_heartbeat: null,
      spawn_failure_count: 2,
      last_spawn_failure: createdAt - DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.windowMs,
    });
    const h = createAlarmFixture(sandbox);

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_failed");

    expect(sandbox.spawn_failure_count).toBe(1);
    expect(h.storage.resetCircuitBreaker).toHaveBeenCalledOnce();
  });

  it("schedules a follow-up within the connecting timeout window", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs / 2,
      last_heartbeat: null,
    });
    const h = createAlarmFixture(sandbox);

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
    expect(h.alarmScheduler.schedule).toHaveBeenCalledOnce();
  });

  it("is not failed past the watchdog window while heartbeats arrive", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs * 3,
      last_heartbeat: Date.now() - 5_000,
    });
    const h = createAlarmFixture(sandbox);
    vi.mocked(h.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(sandbox.status).toBe("connecting");
    expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
  });

  it("waits for a dropped bridge instead of spawning a replacement past the staleness bound", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.spawn.spawningTimeoutMs * 2,
      last_heartbeat: Date.now() - 20_000,
    });
    const h = createAlarmFixture(sandbox);

    await h.manager.spawnSandbox();

    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("connecting");
  });
});
