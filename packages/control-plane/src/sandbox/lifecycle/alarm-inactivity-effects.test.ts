import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import {
  createAlarmFixture,
  createMockSandbox,
  createMockProvider,
  createMockSession,
  noLifetime,
} from "./test-helpers";

describe("inactivity alarm effects", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "heartbeat before remaining inactivity",
      source: "user",
      ageMs: 120_000,
      clients: 0,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.heartbeat.timeoutMs + 1,
    },
    {
      name: "minimum interval",
      source: "user",
      ageMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      clients: 0,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.minCheckIntervalMs,
    },
    {
      name: "client extension",
      source: "user",
      ageMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs,
      clients: 2,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.extensionMs,
    },
    {
      name: "unattended client extension",
      source: "automation",
      ageMs: 120_000,
      clients: 2,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.extensionMs,
    },
  ] as const)(
    "schedules $name at an absolute deadline",
    async ({ source, ageMs, clients, delayMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000_000);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const now = Date.now();
      const sandbox = createMockSandbox({ last_heartbeat: now, last_activity: now - ageMs });
      const h = createAlarmFixture(sandbox, createMockProvider(), clients);
      vi.mocked(h.storage.getSession).mockReturnValue(createMockSession({ spawn_source: source }));
      const requestShutdown = vi.spyOn(h.shutdown, "requestShutdown");

      await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

      expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(now + delayMs);
      expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      expect(requestShutdown).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalledWith(
        expect.stringContaining('"event":"sandbox.inactivity_timeout"')
      );
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
    }
  );

  describe.each(["owned", "unmanaged"] as const)("%s inactivity shutdown event", (ownership) => {
    it.each([
      ["automation", 120_000],
      ["github-bot", 120_000],
      ["agent", 120_000],
      ["user", 600_000],
      ["linear-bot", 600_000],
      ["slack-bot", 600_000],
      [undefined, 600_000],
    ] as const)("logs the current %s source once before shutdown", async (source, timeoutMs) => {
      const now = 10_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const sandbox = createMockSandbox({ last_heartbeat: now, last_activity: now - 120_000 });
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
          stopSandbox: vi.fn(async () => ({ success: true })),
        })
      );
      const requestShutdown = vi.spyOn(h.shutdown, "requestShutdown").mockResolvedValue(ownership);
      vi.mocked(h.storage.getSession).mockReturnValue(null);

      await expect(h.manager.handleAlarm()).resolves.toBe("no_action");
      expect(requestShutdown).not.toHaveBeenCalled();

      vi.mocked(h.storage.getSession).mockReturnValue(
        source ? createMockSession({ spawn_source: source }) : null
      );
      sandbox.last_activity = now - timeoutMs - 17;
      await expect(h.manager.handleAlarm()).resolves.toBe(
        ownership === "unmanaged" ? "sandbox_terminated" : "no_action"
      );

      expect(requestShutdown).toHaveBeenCalledExactlyOnceWith("inactivity_timeout");
      const events = output.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events.filter((event) => event.event === "sandbox.inactivity_timeout")).toEqual([
        expect.objectContaining({
          event: "sandbox.inactivity_timeout",
          spawn_source: source ?? null,
          timeout_ms: timeoutMs,
          idle_ms: timeoutMs + 17,
        }),
      ]);
      const eventIndex = events.findIndex((event) => event.event === "sandbox.inactivity_timeout");
      expect(output.mock.invocationCallOrder[eventIndex]).toBeLessThan(
        requestShutdown.mock.invocationCallOrder[0]
      );
      expect(events).not.toContainEqual(expect.objectContaining({ event: "sandbox.timeout" }));
    });
  });

  it.each(["owned", "held"] as const)(
    "waits for shutdown ownership and avoids legacy effects when %s",
    async (ownership) => {
      const sandbox = createMockSandbox({
        last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
        code_server_url: "https://code.test",
      });
      const original = { ...sandbox };
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox: vi.fn(async () => ({ success: true })),
        })
      );
      let releaseOwnership!: (result: "owned" | "held") => void;
      const decision = new Promise<"owned" | "held">((resolve) => {
        releaseOwnership = resolve;
      });
      vi.spyOn(h.shutdown, "requestShutdown").mockReturnValue(decision);
      const pending = h.manager.handleAlarm();

      try {
        expect(h.shutdown.requestShutdown).toHaveBeenCalledExactlyOnceWith("inactivity_timeout");
        expect(sandbox).toEqual(original);
        expect(h.broadcaster.messages).toEqual([]);
      } finally {
        releaseOwnership(ownership);
        await pending;
      }

      await expect(pending).resolves.toBe("no_action");
      expect(sandbox).toEqual(original);
      expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
      expect(h.storage.clearSandboxAccess).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.provider.stopSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      expect(h.broadcaster.messages).toEqual([]);
    }
  );

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
          snapshotRequiresShutdown: true,
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

  it("stops resumable sandboxes without snapshotting, preserving access secrets", async () => {
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
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("ttyd");
    expect(sandbox).toMatchObject({
      code_server_url: null,
      code_server_password: "code-secret",
      vnc_url: null,
      vnc_password: "vnc-secret",
      ttyd_url: null,
      ttyd_token: "terminal-secret",
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

  it("resumes the retained workspace after an unattended inactivity stop", async () => {
    const now = 10_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sandbox = createMockSandbox({ last_heartbeat: now, last_activity: now - 120_000 });
    const providerObjectId = sandbox.modal_object_id;
    const sandboxId = sandbox.modal_sandbox_id;
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
        resumeSandbox: vi.fn(async () => ({ success: true as const, lifetime: noLifetime() })),
      })
    );
    vi.mocked(h.storage.getSession).mockReturnValue(
      createMockSession({ spawn_source: "automation" })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");
    expect(sandbox.status).toBe("stopped");

    await h.manager.spawnSandbox();

    expect(h.provider.resumeSandbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerObjectId, sandboxId })
    );
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("connecting");
    expect(sandbox.modal_object_id).toBe(providerObjectId);
  });
});
