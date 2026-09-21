import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import { createAlarmFixture, createMockSandbox, createMockProvider } from "./test-helpers";

describe("inactivity alarm effects", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "remaining inactivity",
      ageMs: 120_000,
      clients: 0,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 120_000,
    },
    {
      name: "minimum interval",
      ageMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      clients: 0,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.minCheckIntervalMs,
    },
    {
      name: "client extension",
      ageMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs,
      clients: 2,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.extensionMs,
    },
  ])("schedules $name at an absolute deadline", async ({ ageMs, clients, delayMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const now = Date.now();
    const sandbox = createMockSandbox({ last_heartbeat: now, last_activity: now - ageMs });
    const h = createAlarmFixture(sandbox, createMockProvider(), clients);

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(now + delayMs);
    expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    expect(h.broadcaster.messages).toEqual(
      clients
        ? [
            {
              type: "sandbox_warning",
              message:
                "Sandbox will stop in 5 minutes due to inactivity. Send a message to keep it alive.",
            },
          ]
        : []
    );
  });

  describe.each(["rejected", "unsuccessful"] as const)("%s provider stop", (failure) => {
    it.each([false, true])("still retires and warns (resumable=%s)", async (resumable) => {
      const sandbox = createMockSandbox({
        last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
        code_server_url: "https://code.test",
      });
      const stopSandbox = vi.fn(async () => {
        if (failure === "rejected") throw new Error("provider stop unavailable");
        return { success: false, error: "provider stop unavailable" };
      });
      const stopLog = vi.spyOn(console, "error").mockImplementation(() => {});
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
          reason: "inactivity_timeout",
          intent: resumable ? "preserve" : "destroy",
        })
      );
      expect(stopLog).toHaveBeenCalledWith(
        expect.stringContaining('"error":"provider stop unavailable"')
      );
      expect(sandbox.code_server_url).toBeNull();
      expect(sandbox.status).toBe("stopped");
      expect(h.manager.isSpawning()).toBe(false);
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "stopped" });
      expect(h.broadcaster.messages).toContainEqual({
        type: "sandbox_warning",
        message: resumable
          ? "Sandbox stopped due to inactivity"
          : "Sandbox stopped due to inactivity, snapshot saved",
      });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Inactivity timeout"
      );
      expect(h.provider.takeSnapshot).toHaveBeenCalledTimes(resumable ? 0 : 1);
      expect(h.wsManager.sendToSandbox).toHaveBeenCalledTimes(resumable ? 0 : 1);
    });
  });

  it("does not explicitly stop providers when the capability is disabled", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: false, supportsPersistentResume: false },
        stopSandbox,
      })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

    expect(sandbox.status).toBe("stopped");
    expect(h.provider.takeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        providerObjectId: sandbox.modal_object_id,
        reason: "inactivity_timeout",
      })
    );
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
  });

  it("preserves a destructive-snapshot sandbox before inactivity destroys it", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
    });
    const order: string[] = [];
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: {
          snapshotStopsSandbox: true,
          supportsExplicitStop: true,
          supportsPersistentResume: false,
        },
        takeSnapshot: vi.fn(async () => {
          order.push("snapshot");
          return { success: true, imageId: "legacy-vercel-snapshot" };
        }),
        stopSandbox: vi.fn(async () => {
          order.push("stop");
          return { success: true };
        }),
      })
    );

    await h.manager.handleAlarm();

    expect(order).toEqual(["snapshot", "stop"]);
    expect(sandbox.snapshot_image_id).toBe("legacy-vercel-snapshot");
  });

  it("stops resumable sandboxes without snapshotting, preserving code-server and VNC secrets", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      code_server_url: "https://code.test",
      code_server_password: "code-secret",
      vnc_url: "https://vnc.test",
      vnc_password: "vnc-secret",
      ttyd_url: "https://terminal.test",
      ttyd_token: "terminal-secret",
      tunnel_urls: '{"3000":"https://preview.test"}',
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox,
      })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        providerObjectId: sandbox.modal_object_id,
        reason: "inactivity_timeout",
        intent: "preserve",
      })
    );
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("codeServer");
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("vnc");
    expect(sandbox).toMatchObject({
      code_server_url: null,
      code_server_password: "code-secret",
      vnc_url: null,
      vnc_password: "vnc-secret",
      ttyd_url: null,
      ttyd_token: null,
      tunnel_urls: null,
    });
  });

  it("clears complete access when URL-only clearing is unavailable", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      vnc_url: "https://vnc.test",
      vnc_password: "encrypted-vnc-password",
    });
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
      })
    );
    delete h.storage.clearSandboxAccessUrl;

    await h.manager.handleAlarm();

    expect(h.storage.calls).toContain("clearSandboxAccess:vnc");
    expect(sandbox.vnc_url).toBeNull();
    expect(sandbox.vnc_password).toBeNull();
  });
});
