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
    it.each([false, true])(
      "defers provider I/O to final shutdown (resumable=%s)",
      async (resumable) => {
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

        await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

        expect(stopSandbox).not.toHaveBeenCalled();
        expect(stopLog).not.toHaveBeenCalled();
        expect(sandbox.code_server_url).toBe("https://code.test");
        expect(sandbox.status).toBe("ready");
        expect(h.shutdown.snapshot()).toMatchObject({
          phase: "draining",
          availableRecoveryActions: [],
        });
        expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_access_changed" });
        expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
        expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      }
    );
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

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(sandbox.status).toBe("ready");
    expect(h.shutdown.snapshot()).toMatchObject({ phase: "draining" });
    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
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

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(order).toEqual([]);
    expect(h.shutdown.snapshot()).toMatchObject({ phase: "draining" });
    expect(sandbox.snapshot_image_id).toBeNull();
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

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("codeServer");
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("vnc");
    expect(sandbox).toMatchObject({
      code_server_url: "https://code.test",
      code_server_password: "code-secret",
      vnc_url: "https://vnc.test",
      vnc_password: "vnc-secret",
      ttyd_url: "https://terminal.test",
      ttyd_token: "terminal-secret",
      tunnel_urls: '{"3000":"https://preview.test"}',
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

    expect(h.storage.calls).not.toContain("clearSandboxAccess:vnc");
    expect(h.shutdown.snapshot()).toMatchObject({ phase: "draining" });
    expect(sandbox.vnc_url).toBe("https://vnc.test");
    expect(sandbox.vnc_password).toBe("encrypted-vnc-password");
  });
});
