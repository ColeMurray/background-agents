import { afterEach, describe, it, expect, vi } from "vitest";
import { SandboxLifecycleManager, DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import type { SandboxProvider, SnapshotResult, StopResult } from "../provider";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createMockProvider,
  createTestConfig,
} from "./test-helpers";

function createAlarmFixture(
  sandbox: ReturnType<typeof createMockSandbox> | null,
  provider = createMockProvider(),
  clientCount = 0
) {
  const storage = createMockStorage(createMockSession(), sandbox);
  const broadcaster = createMockBroadcaster();
  const wsManager = createMockWebSocketManager(false, clientCount);
  const alarmScheduler = createMockAlarmScheduler();
  const manager = new SandboxLifecycleManager(
    provider,
    storage,
    storage,
    broadcaster,
    wsManager,
    alarmScheduler,
    createMockIdGenerator(),
    createTestConfig()
  );
  return { manager, storage, broadcaster, wsManager, alarmScheduler, provider };
}

describe("alarm effect regressions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { status: "spawning", resumable: false },
    { status: "spawning", resumable: true },
    { status: "connecting", resumable: false },
    { status: "connecting", resumable: true },
    { status: "ready", resumable: true },
  ] as const)(
    "stops a heartbeat-stale $status sandbox (resumable=$resumable) without snapshot or shutdown",
    async ({ status, resumable }) => {
      const sandbox = createMockSandbox({
        status,
        last_heartbeat: Date.now() - DEFAULT_LIFECYCLE_CONFIG.heartbeat.timeoutMs - 1,
      });
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: resumable },
          stopSandbox,
        })
      );

      await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

      expect(stopSandbox).toHaveBeenCalledExactlyOnceWith({
        providerObjectId: sandbox.modal_object_id,
        sessionId: "test-session",
        reason: "heartbeat_timeout",
        signal: undefined,
      });
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
        expect.objectContaining({ reason: `${trigger}_timeout` })
      );
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ reason: `${trigger}_timeout` })
      );
      expect(order).toEqual([
        "snapshot:start",
        "snapshot:complete",
        ...(trigger === "heartbeat" ? ["stop", "shutdown"] : ["shutdown", "stop"]),
        "detach",
      ]);
      expect(sandbox.snapshot_image_id).toBe("snapshot-complete");
      expect(sandbox.status).toBe(trigger === "heartbeat" ? "stale" : "stopped");
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
    const h = createAlarmFixture(sandbox, createMockProvider({ takeSnapshot }));
    const snapshot = vi.spyOn(h.manager, "triggerSnapshot");
    const pending = h.manager.handleAlarm();

    try {
      await expect(pending).resolves.toBe("sandbox_terminated");
      expect(takeSnapshot).toHaveBeenCalledOnce();
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
  });

  describe.each(["rejected", "unsuccessful"] as const)("%s provider stop", (failure) => {
    it.each([
      { trigger: "watchdog", status: "connecting", resumable: false },
      { trigger: "heartbeat", status: "connecting", resumable: false },
      { trigger: "heartbeat", status: "connecting", resumable: true },
      { trigger: "heartbeat", status: "ready", resumable: false },
      { trigger: "heartbeat", status: "ready", resumable: true },
      { trigger: "inactivity", status: "ready", resumable: false },
      { trigger: "inactivity", status: "ready", resumable: true },
      { trigger: "budget", status: "connecting", resumable: false },
    ] as const)(
      "preserves $trigger effects for $status (resumable=$resumable)",
      async ({ trigger, status, resumable }) => {
        const now = Date.now();
        const sandbox = createMockSandbox({
          status,
          created_at: now - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs,
          last_heartbeat:
            trigger === "watchdog" ? null : trigger === "heartbeat" ? now - 100_000 : now,
          last_activity: now - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
          code_server_url: "https://code.test",
        });
        const stopSandbox = vi.fn(async () => {
          if (failure === "rejected") throw new Error("provider stop unavailable");
          return { success: false, error: "provider stop unavailable" };
        });
        const stopLog = vi
          .spyOn(console, trigger === "inactivity" ? "error" : "warn")
          .mockImplementation(() => {});
        const h = createAlarmFixture(
          sandbox,
          createMockProvider({
            capabilities: { supportsExplicitStop: true, supportsPersistentResume: resumable },
            stopSandbox,
          })
        );

        const result = await h.manager.handleAlarm();

        expect(stopSandbox).toHaveBeenCalledOnce();
        expect(stopLog).toHaveBeenCalledWith(
          expect.stringContaining('"error":"provider stop unavailable"')
        );
        expect(sandbox.code_server_url).toBeNull();
        expect(h.manager.isSpawning()).toBe(false);
        const failed = trigger === "watchdog" || trigger === "budget";
        const terminalStatus = failed ? "failed" : trigger === "heartbeat" ? "stale" : "stopped";
        expect(sandbox.status).toBe(terminalStatus);
        expect(h.broadcaster.messages).toContainEqual({
          type: "sandbox_status",
          status: terminalStatus,
        });
        expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
        if (failed) {
          expect(sandbox.last_spawn_error).toEqual(expect.any(String));
          expect(sandbox.last_spawn_error).not.toContain("provider stop unavailable");
          expect(h.broadcaster.messages).toContainEqual({
            type: "sandbox_error",
            error: sandbox.last_spawn_error,
          });
          expect(sandbox.fenced).toBe(1);
          expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
        }
        if (trigger === "budget") {
          expect(result).toEqual({
            kind: "boot_budget_exceeded",
            reason: sandbox.last_spawn_error,
          });
          expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
            1000,
            "Boot budget exceeded"
          );
        } else if (trigger === "watchdog") {
          expect(result).toBe("sandbox_failed");
          // The never-connected watchdog fences, but does not detach a socket.
          expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
        } else {
          expect(result).toBe("sandbox_terminated");
          expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
            1000,
            trigger === "heartbeat" ? "Heartbeat stale" : "Inactivity timeout"
          );
        }
        if (trigger === "inactivity") {
          expect(h.broadcaster.messages).toContainEqual({
            type: "sandbox_warning",
            message: resumable
              ? "Sandbox stopped due to inactivity"
              : "Sandbox stopped due to inactivity, snapshot saved",
          });
        }
      }
    );
  });

  it("blocks actual replacement and repeat alarms during a budget stop without overwriting the failure", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs,
    });
    let releaseStop!: (result: StopResult) => void;
    const stopSandbox = vi.fn(
      () =>
        new Promise<StopResult>((resolve) => {
          releaseStop = resolve;
        })
    );
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox,
      })
    );
    const pending = h.manager.handleAlarm();
    let reason: string | null = null;

    try {
      await vi.waitFor(() => expect(stopSandbox).toHaveBeenCalledOnce());
      reason = sandbox.last_spawn_error;
      expect(reason).toContain("Sandbox boot exceeded");
      expect(h.manager.isSpawning()).toBe(true);
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_error", error: reason });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledOnce();
      const messages = [...h.broadcaster.messages];

      await h.manager.spawnSandbox();
      await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

      expect(h.storage.updateSandboxForSpawn).not.toHaveBeenCalled();
      expect(h.storage.updateSandboxForResume).not.toHaveBeenCalled();
      expect(h.provider.createSandbox).not.toHaveBeenCalled();
      expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.storage.setLastSpawnError).toHaveBeenCalledExactlyOnceWith(
        reason,
        expect.any(Number)
      );
      expect(sandbox.last_spawn_error).toBe(reason);
      expect(sandbox.spawn_failure_count).toBe(1);
      expect(h.broadcaster.messages).toEqual(messages);
      expect(stopSandbox).toHaveBeenCalledOnce();
      expect(h.wsManager.sendToSandbox).toHaveBeenCalledExactlyOnceWith({ type: "shutdown" });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledOnce();
    } finally {
      releaseStop({ success: true });
      await pending;
    }

    await expect(pending).resolves.toEqual({ kind: "boot_budget_exceeded", reason });
    expect(h.manager.isSpawning()).toBe(false);
    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");
    expect(h.storage.incrementCircuitBreakerFailure).toHaveBeenCalledOnce();
    expect(h.storage.setLastSpawnError).toHaveBeenCalledOnce();
    expect(stopSandbox).toHaveBeenCalledOnce();
  });

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
          : {
              kind: "boot_budget_exceeded",
              reason: sandbox.last_spawn_error,
            }
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
        createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox,
        })
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
});

describe("SandboxLifecycleManager", () => {
  describe("a booting generation whose bridge has connected", () => {
    const BOOT_BUDGET_MS = DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs;

    function build(
      sandbox: ReturnType<typeof createMockSandbox>,
      opts: { hasSocket?: boolean; provider?: SandboxProvider } = {}
    ) {
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(opts.hasSocket ?? true);
      const provider = opts.provider ?? createMockProvider();
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );
      return { storage, broadcaster, wsManager, provider, manager };
    }

    it("is not failed by the connect watchdog past its window while heartbeats arrive", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting",
        created_at: now - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs * 3,
        last_heartbeat: now - 5_000,
      });
      const { manager, storage } = build(sandbox);

      expect(await manager.handleAlarm()).toBe("no_action");
      expect(sandbox.status).toBe("connecting");
      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
    });

    it("waits for a dropped bridge instead of spawning a replacement past the staleness bound", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting",
        created_at: now - DEFAULT_LIFECYCLE_CONFIG.spawn.spawningTimeoutMs * 2,
        last_heartbeat: now - 20_000,
      });
      const { manager, provider } = build(sandbox, { hasSocket: false });

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(sandbox.status).toBe("connecting");
    });

    it("counts a heartbeat-stale boot as a failure and terminates it without snapshotting", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting",
        created_at: now - 300_000,
        last_heartbeat: now - 100_000,
      });
      const { manager, provider, wsManager } = build(sandbox, { hasSocket: false });

      expect(await manager.handleAlarm()).toBe("sandbox_terminated");

      expect(sandbox.status).toBe("stale");
      expect(sandbox.spawn_failure_count).toBe(1);
      expect(provider.takeSnapshot).not.toHaveBeenCalled();
      // A stale row has no adoptable socket, so a shutdown here could never
      // be delivered; the bridge is gone and the detach is what remains.
      expect(wsManager.sendToSandbox).not.toHaveBeenCalled();
      expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(1000, "Heartbeat stale");
    });

    it("still snapshots a ready sandbox that goes heartbeat-stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({ status: "ready", last_heartbeat: now - 100_000 });
      const { manager, provider } = build(sandbox, { hasSocket: false });

      await manager.handleAlarm();

      expect(provider.takeSnapshot).toHaveBeenCalled();
      expect(sandbox.spawn_failure_count).toBe(0);
    });

    describe("boot budget", () => {
      function expired() {
        const now = Date.now();
        return createMockSandbox({
          status: "connecting",
          created_at: now - BOOT_BUDGET_MS,
          last_heartbeat: now - 5_000,
          boot_phase: JSON.stringify({
            phase: "setup",
            status: "started",
            repoOwner: "acme",
            repoName: "api",
          }),
          code_server_url: "https://code.test",
        });
      }

      it("shuts the runtime down over the socket, fences the generation, fails the row and counts it", async () => {
        const sandbox = expired();
        const { manager, storage, broadcaster, wsManager } = build(sandbox);
        const order: string[] = [];
        vi.mocked(wsManager.sendToSandbox).mockImplementation((message) => {
          order.push(`send:${(message as { type: string }).type}`);
          return true;
        });
        vi.mocked(storage.fenceSandboxGeneration).mockImplementation(() => {
          order.push("fence");
          sandbox.fenced = 1;
          sandbox.auth_token_hash = "";
          sandbox.active_socket_id = "";
        });
        vi.mocked(storage.updateSandboxStatus).mockImplementation((status) => {
          order.push(`status:${status}`);
          sandbox.status = status;
        });

        const result = await manager.handleAlarm();

        expect(result).toEqual({
          kind: "boot_budget_exceeded",
          reason: expect.stringContaining("SANDBOX_BOOT_TIMEOUT_MS"),
        });
        // The shutdown must go out while the socket is still adoptable: the
        // lifecycle send path refuses a failed row.
        expect(order).toEqual(["send:shutdown", "fence", "status:failed"]);
        expect(sandbox.fenced).toBe(1);
        expect(sandbox.auth_token_hash).toBe("");
        expect(sandbox.spawn_failure_count).toBe(1);
        expect(sandbox.code_server_url).toBeNull();
        expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(1000, "Boot budget exceeded");
        expect(broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "failed" });
        const error = broadcaster.messages.find(
          (m) => (m as { type: string }).type === "sandbox_error"
        ) as { error: string } | undefined;
        expect(error?.error).toContain("30 minutes");
        expect(error?.error).toContain("setup.sh");
        expect(error?.error).toContain("acme/api");
        expect(sandbox.last_spawn_error).toBe(error?.error);
      });

      it("stops the provider sandbox where the provider can", async () => {
        const sandbox = expired();
        const stopSandbox = vi.fn(async () => ({ success: true }));
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox,
        });
        const { manager } = build(sandbox, { provider });

        await manager.handleAlarm();

        expect(stopSandbox).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "boot_budget_exceeded" })
        );
      });

      it("publishes the failure and holds the spawn guard while the provider stop is pending", async () => {
        // The stop is a network round trip. A prompt that arrives during it
        // must not reserve a replacement that then inherits this failure,
        // and the user must not wait out the stop to learn the boot died.
        const sandbox = expired();
        let releaseStop!: () => void;
        const stopSandbox = vi.fn(
          () =>
            new Promise<StopResult>((resolve) => {
              releaseStop = () => resolve({ success: true });
            })
        );
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox,
        });
        const { manager, broadcaster } = build(sandbox, { provider });

        const pending = manager.handleAlarm();
        await vi.waitFor(() => expect(stopSandbox).toHaveBeenCalledOnce());

        expect(broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "failed" });
        expect(
          broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_error")
        ).toBe(true);
        expect(sandbox.last_spawn_error).toContain("Sandbox boot exceeded");
        expect(manager.isSpawning()).toBe(true);

        releaseStop();
        await expect(pending).resolves.toEqual(
          expect.objectContaining({ kind: "boot_budget_exceeded" })
        );
        expect(manager.isSpawning()).toBe(false);
      });

      it("names the boot itself when no phase was reported", async () => {
        const sandbox = expired();
        sandbox.boot_phase = null;
        const { manager, broadcaster } = build(sandbox);

        await manager.handleAlarm();

        const error = broadcaster.messages.find(
          (m) => (m as { type: string }).type === "sandbox_error"
        ) as { error: string } | undefined;
        expect(error?.error).toMatch(/^Sandbox boot exceeded 30 minutes while booting\./);
      });

      it("does not apply to a ready sandbox, however old its reservation", async () => {
        const now = Date.now();
        const sandbox = createMockSandbox({
          status: "ready",
          created_at: now - BOOT_BUDGET_MS * 2,
          last_heartbeat: now - 5_000,
          last_activity: now - 5_000,
        });
        const { manager, storage } = build(sandbox);

        expect(await manager.handleAlarm()).toBe("no_action");
        expect(storage.fenceSandboxGeneration).not.toHaveBeenCalled();
        expect(sandbox.status).toBe("ready");
      });
    });
  });
  describe("handleAlarm", () => {
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
        const storage = createMockStorage(createMockSession(), sandbox);
        const wsManager = createMockWebSocketManager(false);
        const checkStartup = async () => {
          expect(sandbox.status).toBe("spawning");
          expect(await manager.handleAlarm()).toBe("no_action");
          expect(sandbox.status).toBe("spawning");
        };
        const provider = createMockProvider({
          createSandbox: vi.fn(async (config) => {
            await checkStartup();
            return { sandboxId: config.sandboxId, status: "connecting", createdAt: Date.now() };
          }),
          restoreFromSnapshot: vi.fn(async (config) => {
            await checkStartup();
            return { success: true, sandboxId: config.sandboxId };
          }),
        });
        const manager = new SandboxLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          wsManager,
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createTestConfig()
        );

        await manager.spawnSandbox();

        expect(
          kind === "restore" ? provider.restoreFromSnapshot : provider.createSandbox
        ).toHaveBeenCalledOnce();
        expect(sandbox.status).toBe("connecting");
        expect(sandbox.last_heartbeat).toBeNull();
        expect(wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
        expect(provider.takeSnapshot).not.toHaveBeenCalled();
      }
    );

    it("detects heartbeat timeout and sets stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // 100 seconds ago, past 90s timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const result = await manager.handleAlarm();

      expect(result).toBe("sandbox_terminated");
      expect(storage.calls).toContain("updateSandboxStatus:stale");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "stale")).toBe(
        true
      );
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(1000, "Heartbeat stale");
    });

    it("handles inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000, // Recent heartbeat
        last_activity: now - 11 * 60 * 1000, // 11 minutes ago, past 10 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0); // No clients
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const result = await manager.handleAlarm();

      expect(result).toBe("sandbox_terminated");
      expect(storage.calls).toContain("updateSandboxStatus:stopped");
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
    });

    it("extends timeout when clients connected", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 2); // 2 clients connected
      const alarmScheduler = createMockAlarmScheduler();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      // Should extend, not timeout
      expect(storage.calls).not.toContain("updateSandboxStatus:stopped");
      expect(alarmScheduler.alarms.length).toBe(1);
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_warning")
      ).toBe(true);
    });

    it("schedules next alarm correctly", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 5 * 60 * 1000, // 5 minutes ago, not yet timed out
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0);
      const alarmScheduler = createMockAlarmScheduler();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:stopped");
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("triggers snapshot before stopping", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).toHaveBeenCalled();
    });

    it("snapshots and explicitly stops non-resumable providers on inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const wsManager = createMockWebSocketManager(false, 0);
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: false },
        stopSandbox,
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(storage.calls).toContain("clearSandboxAccess:codeServer");
      expect(storage.calls).toContain("clearSandboxAccess:vnc");
    });

    it("does not explicitly stop providers when the capability is disabled", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const wsManager = createMockWebSocketManager(false, 0);
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: false, supportsPersistentResume: false },
        stopSandbox,
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(stopSandbox).not.toHaveBeenCalled();
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
    });

    it("stops resumable provider-managed sandboxes without snapshotting", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000,
        code_server_url: "https://code.test",
        code_server_password: "encrypted-password",
        vnc_url: "https://vnc.test",
        vnc_password: "encrypted-vnc-password",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox,
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false, 0),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).not.toHaveBeenCalled();
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(storage.calls).toContain("clearSandboxAccessUrl:codeServer");
      expect(storage.calls).not.toContain("clearSandboxAccess:codeServer");
      expect(storage.calls).toContain("clearSandboxAccessUrl:vnc");
      expect(storage.calls).not.toContain("clearSandboxAccess:vnc");
      expect(sandbox.vnc_password).toBe("encrypted-vnc-password");
    });

    it("clears complete access when URL-only clearing is unavailable", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000,
        vnc_url: "https://vnc.test",
        vnc_password: "encrypted-vnc-password",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      delete storage.clearSandboxAccessUrl;
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false, 0),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("clearSandboxAccess:vnc");
      expect(sandbox.vnc_url).toBeNull();
      expect(sandbox.vnc_password).toBeNull();
    });

    it("detects connecting timeout and sets failed", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 10_000),
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const result = await manager.handleAlarm();

      expect(result).toBe("sandbox_failed");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(storage.calls).toContain("clearSandboxAccess:codeServer");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "failed")).toBe(
        true
      );
      expect(
        broadcaster.messages.some((m) => (m as { type?: string }).type === "sandbox_error")
      ).toBe(true);
      // The reason is persisted alongside the broadcast, so reloading to
      // investigate still shows why the sandbox failed.
      expect(sandbox.last_spawn_error).toContain("failed to connect");
      // Should NOT trigger snapshot (nothing to snapshot)
      expect(provider.takeSnapshot).not.toHaveBeenCalled();
    });

    it("counts a connecting timeout toward the circuit breaker", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 10_000),
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await expect(manager.handleAlarm()).resolves.toBe("sandbox_failed");

      expect(sandbox.spawn_failure_count).toBe(1);
      expect(sandbox.last_spawn_failure).toBeGreaterThanOrEqual(now);
    });

    it("fences the generation before an explicit provider stop, so a late bridge is refused rather than adopted", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 10_000),
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const order: string[] = [];
      vi.mocked(storage.fenceSandboxGeneration).mockImplementation(() => {
        order.push("fence");
        sandbox.fenced = 1;
      });
      const stopSandbox = vi.fn(async () => {
        order.push("stop");
        return { success: true };
      });
      const manager = new SandboxLifecycleManager(
        createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox }),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await expect(manager.handleAlarm()).resolves.toBe("sandbox_failed");

      expect(order).toEqual(["fence", "stop"]);
      expect(sandbox.fenced).toBe(1);
    });

    it("leaves a watchdog-failed generation unfenced when the provider cannot be stopped, so its late bridge may self-heal", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 10_000),
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await expect(manager.handleAlarm()).resolves.toBe("sandbox_failed");

      expect(storage.fenceSandboxGeneration).not.toHaveBeenCalled();
      expect(sandbox.fenced).toBe(0);
    });

    it("restarts the streak when this attempt began a full window after the previous failure", async () => {
      // The window measures the idle gap between the previous failure and the
      // start of the attempt that failed. An attempt begun after the previous
      // streak expired starts a new streak of one; it must not resurrect and
      // extend a streak the breaker would already ignore.
      const now = Date.now();
      const createdAt = now - (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 10_000);
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: createdAt,
        last_heartbeat: null,
        spawn_failure_count: 2,
        last_spawn_failure: createdAt - DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.windowMs,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await expect(manager.handleAlarm()).resolves.toBe("sandbox_failed");

      expect(sandbox.spawn_failure_count).toBe(1);
    });

    it("does not timeout connecting sandbox within timeout window", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs / 2,
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
      // Should schedule a follow-up alarm
      expect(alarmScheduler.alarms.length).toBe(1);
    });
  });
});
