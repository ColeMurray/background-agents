import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import { createAlarmFixture, createMockProvider, createMockSandbox } from "./test-helpers";

const NOW = Date.UTC(2026, 9, 3, 5);
const { heartbeat, inactivity, spawn } = DEFAULT_LIFECYCLE_CONFIG;
// Older than every age-based spawn bound, so only the reconnect rule can hold it.
const LONG_AGO = NOW - spawn.spawningTimeoutMs - 1;
const RECENT_HEARTBEAT = NOW - 10_000;
const STALE_HEARTBEAT = NOW - heartbeat.timeoutMs - 1;
const LIVE_STATUSES = ["spawning", "connecting", "ready", "snapshotting"] as const;

function connectedSource(overrides: Parameters<typeof createMockSandbox>[0] = {}) {
  return createMockSandbox({
    created_at: LONG_AGO,
    last_heartbeat: RECENT_HEARTBEAT,
    snapshot_image_id: "earlier-checkpoint",
    snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
    ...overrides,
  });
}

describe("sandbox continuity while its bridge reconnects", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it.each(
    LIVE_STATUSES.flatMap((status) => [
      [status, RECENT_HEARTBEAT],
      [status, STALE_HEARTBEAT],
    ])
  )(
    "does not replace a previously connected %s source (heartbeat at %i)",
    async (status, lastHeartbeat) => {
      const sandbox = connectedSource({ status, last_heartbeat: lastHeartbeat });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
      );
      const original = { ...sandbox };

      // A prompt or typing event arrives after a control-plane restart, before
      // the bridge reconnects or the heartbeat alarm runs.
      await h.manager.spawnSandbox();

      expect(h.provider.createSandbox).not.toHaveBeenCalled();
      expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(stopSandbox).not.toHaveBeenCalled();
      expect(h.storage.updateSandboxForSpawn).not.toHaveBeenCalled();
      expect(sandbox).toEqual(original);
    }
  );

  it.each([
    ["a recent", RECENT_HEARTBEAT, RECENT_HEARTBEAT + heartbeat.timeoutMs + 1],
    ["an already stale", STALE_HEARTBEAT, NOW + 1],
  ])(
    "arms the heartbeat deadline of a source with %s heartbeat",
    async (_label, lastHeartbeat, deadline) => {
      const h = createAlarmFixture(connectedSource({ last_heartbeat: lastHeartbeat }));

      await h.manager.spawnSandbox();

      expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(deadline);
    }
  );

  it.each(LIVE_STATUSES)(
    "restores the %s status for clients told a spawn was starting",
    async (status) => {
      const h = createAlarmFixture(connectedSource({ status }));

      await h.manager.spawnSandbox();

      expect(h.broadcaster.messages).toEqual([
        { type: "sandbox_status", status },
        ...(status === "ready" ? [{ type: "sandbox_access_changed" }] : []),
      ]);
    }
  );

  it("keeps the same source after its bridge reconnects", async () => {
    const sandbox = connectedSource();
    const h = createAlarmFixture(sandbox);
    const sourceId = sandbox.modal_sandbox_id;

    await h.manager.spawnSandbox();
    vi.mocked(h.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    await h.manager.spawnSandbox();

    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(sandbox.modal_sandbox_id).toBe(sourceId);
    expect(sandbox.status).toBe("ready");
  });

  it.each(["stopped", "stale", "failed"] as const)(
    "still restores a checkpoint once the source is %s",
    async (status) => {
      const h = createAlarmFixture(connectedSource({ status }));

      await h.manager.spawnSandbox();

      expect(h.provider.restoreFromSnapshot).toHaveBeenCalledOnce();
      expect(h.provider.createSandbox).not.toHaveBeenCalled();
    }
  );

  it("retires a source that does not reconnect at its heartbeat deadline, not the inactivity extension", async () => {
    const sandbox = connectedSource({ last_activity: NOW - inactivity.timeoutMs });
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
      }),
      1
    );

    // The last alarm before the restart extended inactivity for a watching client.
    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");
    expect(h.alarmScheduler.alarms).toEqual([NOW + inactivity.extensionMs]);

    await h.manager.spawnSandbox();
    const deadline = Math.min(...h.alarmScheduler.alarms);
    expect(deadline).toBe(RECENT_HEARTBEAT + heartbeat.timeoutMs + 1);

    vi.mocked(Date.now).mockReturnValue(deadline);
    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");
    expect(h.provider.takeSnapshot).toHaveBeenCalledOnce();
    expect(h.provider.stopSandbox).toHaveBeenCalledOnce();
    expect(sandbox.status).toBe("stale");

    await h.manager.spawnSandbox();
    expect(h.provider.restoreFromSnapshot).toHaveBeenCalledOnce();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["waits for", spawn.cooldownMs - 1, 0],
    ["replaces", spawn.cooldownMs, 1],
  ])(
    "%s a ready source that never connected by the spawn cooldown alone",
    async (_label, ageMs, spawns) => {
      const h = createAlarmFixture(
        createMockSandbox({ created_at: NOW - ageMs, last_heartbeat: null })
      );

      await h.manager.spawnSandbox();

      expect(h.provider.createSandbox).toHaveBeenCalledTimes(spawns);
    }
  );
});
