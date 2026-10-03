import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import { createAlarmFixture, createMockProvider, createMockSandbox } from "./test-helpers";

const NOW = Date.UTC(2026, 9, 3, 5);

describe("sandbox continuity while its bridge reconnects", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["ready", 10_000],
    ["ready", DEFAULT_LIFECYCLE_CONFIG.heartbeat.timeoutMs + 1],
  ] as const)("does not replace a %s source with a %i ms old heartbeat", async (status, ageMs) => {
    const sandbox = createMockSandbox({
      status,
      created_at: NOW - DEFAULT_LIFECYCLE_CONFIG.spawn.readyWaitMs * 3,
      last_heartbeat: NOW - ageMs,
      snapshot_image_id: "earlier-checkpoint",
      snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
    );
    const original = { ...sandbox };

    // A prompt or typing event arrives after a control-plane restart, before
    // the bridge reconnects or the already-scheduled heartbeat alarm runs.
    await h.manager.spawnSandbox();

    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.storage.updateSandboxForSpawn).not.toHaveBeenCalled();
    expect(sandbox).toEqual(original);
  });

  it("keeps the same source after its bridge reconnects", async () => {
    const sandbox = createMockSandbox({
      created_at: NOW - DEFAULT_LIFECYCLE_CONFIG.spawn.readyWaitMs * 3,
      last_heartbeat: NOW - 10_000,
    });
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
      const h = createAlarmFixture(
        createMockSandbox({
          status,
          snapshot_image_id: "saved-workspace",
          snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
        })
      );

      await h.manager.spawnSandbox();

      expect(h.provider.restoreFromSnapshot).toHaveBeenCalledOnce();
      expect(h.provider.createSandbox).not.toHaveBeenCalled();
    }
  );

  it("lets the heartbeat alarm preserve and retire a source that does not reconnect", async () => {
    const sandbox = createMockSandbox({
      created_at: NOW - DEFAULT_LIFECYCLE_CONFIG.spawn.readyWaitMs * 3,
      last_heartbeat: NOW - DEFAULT_LIFECYCLE_CONFIG.heartbeat.timeoutMs - 1,
    });
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
      })
    );

    await h.manager.spawnSandbox();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");
    expect(h.provider.takeSnapshot).toHaveBeenCalledOnce();
    expect(h.provider.stopSandbox).toHaveBeenCalledOnce();
    expect(sandbox.status).toBe("stale");

    await h.manager.spawnSandbox();
    expect(h.provider.restoreFromSnapshot).toHaveBeenCalledOnce();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("still recovers an expired ready source that never connected", async () => {
    const h = createAlarmFixture(
      createMockSandbox({
        created_at: NOW - DEFAULT_LIFECYCLE_CONFIG.spawn.readyWaitMs * 3,
        last_heartbeat: null,
      })
    );

    await h.manager.spawnSandbox();

    expect(h.provider.createSandbox).toHaveBeenCalledOnce();
  });
});
