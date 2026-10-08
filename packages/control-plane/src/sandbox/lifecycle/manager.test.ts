/**
 * Unit tests for SandboxLifecycleManager.
 *
 * Uses mocked dependencies to test lifecycle orchestration logic.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG, type SandboxShutdownLifecycle } from "./manager";
import { TERMINAL_TOKEN_TTL_SECONDS } from "./sandbox-access";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  SandboxProviderError,
  SandboxLaunchRejectedError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import { hashToken } from "../../auth/crypto";
import type * as AuthCrypto from "../../auth/crypto";
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
  createTestLifecycleManager,
  createUnmanagedShutdown,
  createCheckpointShutdown,
  noLifetime,
} from "./test-helpers";

// Gate for the #1589 admission-race suite: hashToken passes through to the
// real implementation, but a test can hold the next call open to keep the
// spawn paused inside its one non-storage await.
let hashTokenGate: Promise<void> = Promise.resolve();
let releaseHashTokenGate: () => void = () => {};
function blockNextHashToken(): void {
  hashTokenGate = new Promise((resolve) => {
    releaseHashTokenGate = resolve;
  });
}
vi.mock("../../auth/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthCrypto>();
  return {
    ...actual,
    hashToken: vi.fn(async (token: string) => {
      await hashTokenGate;
      return actual.hashToken(token);
    }),
  };
});

describe("SandboxLifecycleManager", () => {
  describe("spawnSandbox", () => {
    it.each([
      ["spawn", "public-session-name"],
      ["restore", null],
    ] as const)("signs %s terminal claims with the launch auth key", async (kind, sessionName) => {
      const nowMs = 1_700_000_000_123;
      const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
      try {
        const session = createMockSession({
          session_name: sessionName,
          sandbox_settings: JSON.stringify({ terminalEnabled: true }),
        });
        const sandbox = createMockSandbox({
          status: kind === "spawn" ? "pending" : "stopped",
          snapshot_image_id: kind === "restore" ? "saved-image" : null,
          snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
        });
        const storage = createMockStorage(session, sandbox);
        const ttydUrl = `https://terminal.test/${kind}`;
        const provider = createMockProvider({
          createSandbox: vi.fn(async (config) => ({
            sandboxId: config.sandboxId,
            providerObjectId: "fresh-source",
            createdAt: nowMs,
            lifetime: noLifetime(),
            ttydUrl,
          })),
          restoreFromSnapshot: vi.fn(async (config) => ({
            success: true as const,
            sandboxId: config.sandboxId,
            providerObjectId: "restored-source",
            lifetime: noLifetime(),
            ttydUrl,
          })),
        });
        const manager = createTestLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(false),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createUnmanagedShutdown(),
          createTestConfig()
        );

        await manager.spawnSandbox();

        const launch =
          kind === "spawn"
            ? vi.mocked(provider.createSandbox).mock.calls[0][0]
            : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
        const token = sandbox.ttyd_token;
        expect(token).toEqual(expect.any(String));
        const [header, body, signature] = token!.split(".");
        expect(JSON.parse(atob(header))).toEqual({ alg: "HS256", typ: "JWT" });
        expect(JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
          sub: session.session_name || session.id,
          sid: launch.sandboxId,
          iat: Math.floor(nowMs / 1000),
          exp: Math.floor(nowMs / 1000) + TERMINAL_TOKEN_TTL_SECONDS,
        });
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(launch.sandboxAuthToken),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"]
        );
        expect(
          await crypto.subtle.verify(
            "HMAC",
            key,
            Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
              character.charCodeAt(0)
            ),
            new TextEncoder().encode(`${header}.${body}`)
          )
        ).toBe(true);
        expect(launch.sessionId).toBe(session.session_name || session.id);
        expect(storage.updateSandboxAccess).toHaveBeenCalledExactlyOnceWith("ttyd", ttydUrl, token);
        expect(storage.completeProviderResume).not.toHaveBeenCalled();
        expect(sandbox.ttyd_url).toBe(ttydUrl);
      } finally {
        clock.mockRestore();
      }
    });
  });
});

describe("status writes after a provider await (COL-99)", () => {
  // The provider call is a non-storage await: the alarm, a bridge connect, or
  // a cancel can move the sandbox row while it is in flight, and that verdict
  // stands over the attempt's own late write.
  function harness(
    sandbox: ReturnType<typeof createMockSandbox>,
    createSandbox: (config: CreateSandboxConfig) => Promise<CreateSandboxResult>
  ) {
    const storage = createMockStorage(createMockSession(), sandbox);
    const broadcaster = createMockBroadcaster();
    const manager = createTestLifecycleManager(
      createMockProvider({ createSandbox }),
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );
    return { storage, broadcaster, manager };
  }

  it("retains a late handle for an unfenced failed generation the provider cannot stop", async () => {
    const sandbox = createMockSandbox({ status: "failed" });
    const { storage, broadcaster, manager } = harness(sandbox, async (config) => {
      // Connecting timeout fired: the alarm failed the attempt and told the user.
      sandbox.status = "failed";
      return {
        sandboxId: config.sandboxId,
        providerObjectId: "provider-obj-late",
        status: "connecting",
        createdAt: Date.now(),
        lifetime: noLifetime(),
      };
    });

    await manager.spawnSandbox();

    expect(sandbox.status).toBe("failed");
    expect(storage.calls).toContain("commitProviderStartup");
    expect(broadcaster.messages).not.toContainEqual({
      type: "sandbox_status",
      status: "connecting",
    });
    // The provider-side sandbox exists and a later stop needs its handle.
    expect(sandbox.modal_object_id).toBe("provider-obj-late");
  });

  it("re-drives the queue once a launch the watchdog failed mid-provider-call settles", async () => {
    // The in-flight launch holds startup admission when the watchdog fires, so
    // the alarm's queue pump is refused and a replacement spawn would skip.
    vi.useFakeTimers();
    try {
      const sandbox = createMockSandbox({
        status: "pending",
        last_heartbeat: null,
        modal_object_id: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      let resolveCreate!: (result: CreateSandboxResult) => void;
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockImplementationOnce(
          () =>
            new Promise<CreateSandboxResult>((resolve) => {
              resolveCreate = resolve;
            })
        )
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-replacement",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        }));
      const shutdown = {
        ...createUnmanagedShutdown(),
        reserveStartup: vi.fn((_createdAt, _policy, persist) => persist()),
      } satisfies SandboxShutdownLifecycle;
      const resumeQueuedWork = vi.fn(async () => manager.spawnSandbox());
      const manager = createTestLifecycleManager(
        createMockProvider({
          capabilities: { supportsExplicitStop: true },
          createSandbox,
          stopSandbox: vi.fn(async () => ({ success: true })),
        }),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        { ...createTestConfig(), resumeQueuedWork }
      );

      const spawning = manager.spawnSandbox();
      await vi.waitFor(() => expect(createSandbox).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 1);
      await expect(manager.handleAlarm()).resolves.toBe("sandbox_terminated");
      expect(manager.mayProcessQueuedWork()).toBe(false);
      expect(resumeQueuedWork).not.toHaveBeenCalled();

      resolveCreate({
        sandboxId: sandbox.modal_sandbox_id!,
        providerObjectId: "provider-obj-late",
        createdAt: Date.now(),
        lifetime: noLifetime(),
      });
      await spawning;

      expect(resumeQueuedWork).toHaveBeenCalledOnce();
      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(sandbox.modal_object_id).toBe("provider-obj-replacement");
      expect(sandbox.fenced).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a late provider result after the watchdog fences its generation", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = createMockSandbox({
        status: "pending",
        last_heartbeat: null,
        modal_object_id: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      let resolveCreate!: (result: CreateSandboxResult) => void;
      const createSandbox = vi.fn(
        () =>
          new Promise<CreateSandboxResult>((resolve) => {
            resolveCreate = resolve;
          })
      );
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const shutdown = {
        ...createUnmanagedShutdown(),
        reserveStartup: vi.fn((_createdAt, _policy, persist) => persist()),
        requestShutdown: vi.fn(async () => "owned" as const),
      } satisfies SandboxShutdownLifecycle;
      const manager = createTestLifecycleManager(
        createMockProvider({
          capabilities: { supportsExplicitStop: true },
          createSandbox,
          stopSandbox,
        }),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        createTestConfig()
      );

      const spawning = manager.spawnSandbox();
      await vi.waitFor(() => expect(createSandbox).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 1);
      await expect(manager.handleAlarm()).resolves.toBe("sandbox_terminated");

      resolveCreate({
        sandboxId: sandbox.modal_sandbox_id!,
        providerObjectId: "provider-obj-late",
        createdAt: Date.now(),
        codeServerUrl: "https://late.example",
        codeServerPassword: "late-password",
        lifetime: {
          kind: "finite",
          expiresAtMs: Date.now() + 60_000,
          observedAtMs: Date.now(),
          source: "provider",
        },
      });
      await spawning;

      expect(sandbox.status).toBe("failed");
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.modal_object_id).toBeNull();
      expect(sandbox.code_server_url).toBeNull();
      expect(shutdown.recordProviderStartup).not.toHaveBeenCalled();
      expect(stopSandbox).toHaveBeenCalledOnce();
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "provider-obj-late",
          reason: "startup_superseded",
          intent: "destroy",
          signal: expect.any(AbortSignal),
        })
      );
      expect(broadcaster.messages).not.toContainEqual({
        type: "sandbox_status",
        status: "connecting",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    new SandboxProviderError("quota exceeded", "permanent"),
    new SandboxLaunchRejectedError("incompatible", "sb-rejected"),
  ])(
    "counts an attempt once when the watchdog fails it before the provider rejects it (%s)",
    async (error) => {
      // The connect alarm is armed at reservation, before the provider call,
      // so it can fail the attempt while createSandbox() is still pending. The
      // provider's later rejection is the same attempt, not a second failure.
      vi.useFakeTimers();
      try {
        const sandbox = createMockSandbox({ status: "failed" });
        const h = harness(sandbox, async () => {
          vi.advanceTimersByTime(DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 1000);
          await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_failed");
          throw error;
        });

        await h.manager.spawnSandbox();

        expect(sandbox.status).toBe("failed");
        expect(sandbox.spawn_failure_count).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("leaves a sandbox whose bridge attached during the provider call booting when the call then fails", async () => {
    // The bridge now connects ahead of its boot, so a provider error that
    // lands after attach (E2B's process-start check, a slow restore response)
    // describes a sandbox that is demonstrably alive. The row moved to
    // `connecting` at attach; the attempt must neither fail it nor count it.
    const sandbox = createMockSandbox({ status: "failed" });
    const storage = createMockStorage(createMockSession(), sandbox);
    const broadcaster = createMockBroadcaster();
    const wsManager = createMockWebSocketManager(false);
    const manager = createTestLifecycleManager(
      createMockProvider({
        createSandbox: vi.fn(async () => {
          sandbox.status = "connecting";
          vi.mocked(wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
          throw new SandboxProviderError("process did not start in time", "permanent");
        }),
      }),
      storage,
      storage,
      broadcaster,
      wsManager,
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );

    await manager.spawnSandbox();

    expect(sandbox.status).toBe("connecting");
    expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
    expect(sandbox.spawn_failure_count).toBe(0);
    expect(broadcaster.messages).not.toContainEqual(
      expect.objectContaining({ type: "sandbox_error" })
    );
  });

  it("leaves a sandbox that connected during the provider call ready when the call then fails", async () => {
    const sandbox = createMockSandbox({ status: "failed" });
    const { storage, broadcaster, manager } = harness(sandbox, async () => {
      // The bridge authenticated and published ready before the provider's
      // response (a post-create timeout) came back as an error.
      sandbox.status = "ready";
      throw new SandboxProviderError("read timed out", "transient");
    });

    await manager.spawnSandbox();

    expect(sandbox.status).toBe("ready");
    expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    expect(storage.setLastSpawnError).not.toHaveBeenCalledWith("read timed out", expect.anything());
    expect(broadcaster.messages).not.toContainEqual({
      type: "sandbox_error",
      error: "read timed out",
    });
  });

  it("abandons a reservation that a cancel stopped while its hash was being published", async () => {
    const sandbox = createMockSandbox({ status: "failed" });
    const storage = createMockStorage(createMockSession(), sandbox);
    const broadcaster = createMockBroadcaster();
    const provider = createMockProvider();
    const alarmScheduler = createMockAlarmScheduler();
    vi.mocked(alarmScheduler.schedule).mockImplementation(async () => {
      // The reservation's alarm await: the cancel handler lands here and
      // stops the sandbox without changing its reserved identity.
      sandbox.status = "stopped";
    });
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(false),
      alarmScheduler,
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );

    await manager.spawnSandbox();

    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("stopped");
    expect(sandbox.auth_token_hash).toBe("");
    expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
    expect(storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
  });

  it("does not let a late completion touch a newer reservation that re-entered spawning", async () => {
    // Attempt A's provider call is slow. Its bridge connects early (clearing
    // the in-memory flag), goes stale, and attempt B reserves a new identity,
    // so the row is `spawning` again when A's call returns.
    const sandbox = createMockSandbox({ status: "failed" });
    const storage = createMockStorage(createMockSession(), sandbox);
    const broadcaster = createMockBroadcaster();
    let attempts = 0;
    const provider = createMockProvider({
      createSandbox: vi.fn(async (config) => {
        attempts += 1;
        if (attempts === 1) {
          sandbox.status = "spawning";
          sandbox.modal_sandbox_id = "sb-B";
          sandbox.created_at = config.sandboxId.length + Date.now() + 1;
          throw new SandboxProviderError("late failure of A", "transient");
        }
        return {
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-B",
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        };
      }),
    });
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );

    await manager.spawnSandbox();

    // B's row is untouched by A's failure: still spawning, no error reported.
    expect(sandbox.status).toBe("spawning");
    expect(sandbox.modal_sandbox_id).toBe("sb-B");
    expect(storage.setLastSpawnError).not.toHaveBeenCalledWith(
      "late failure of A",
      expect.anything()
    );
    expect(broadcaster.messages).not.toContainEqual({
      type: "sandbox_error",
      error: "late failure of A",
    });
  });

  it("does not let a late completion touch a newer generation that re-entered snapshotting", async () => {
    const sandbox = createMockSandbox({
      status: "ready",
      modal_sandbox_id: "sb-A",
      created_at: 1000,
    });
    const storage = createMockStorage(createMockSession(), sandbox);
    const broadcaster = createMockBroadcaster();
    const provider = createMockProvider({
      takeSnapshot: vi.fn(async () => {
        // A terminated and was replaced; the replacement is itself snapshotting.
        sandbox.modal_sandbox_id = "sb-B";
        sandbox.created_at = 2000;
        sandbox.status = "snapshotting";
        return { success: true, imageId: "snapshot-of-A" };
      }),
    });
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createCheckpointShutdown(provider, storage, broadcaster),
      createTestConfig()
    );

    await manager.triggerSnapshot("execution_complete");

    expect(sandbox.status).toBe("snapshotting");
    expect(sandbox.snapshot_image_id).toBeNull();
    expect(broadcaster.messages).not.toContainEqual({ type: "sandbox_status", status: "ready" });
  });

  it("still fails and reports an attempt nothing else touched", async () => {
    const sandbox = createMockSandbox({ status: "failed" });
    const { storage, broadcaster, manager } = harness(sandbox, async () => {
      throw new SandboxProviderError("quota exceeded", "permanent");
    });

    await manager.spawnSandbox();

    expect(sandbox.status).toBe("failed");
    expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    expect(storage.setLastSpawnError).toHaveBeenCalledWith("quota exceeded", expect.anything());
    expect(broadcaster.messages).toContainEqual({ type: "sandbox_error", error: "quota exceeded" });
  });
});

describe("checkpoint intent", () => {
  it.each([
    ["execution_complete", "continue"],
    ["heartbeat_timeout", "stop_source"],
    ["inactivity_timeout", "stop_source"],
  ])("tags a %s checkpoint as %s", async (reason, after) => {
    const sandbox = createMockSandbox({ status: "ready" });
    const storage = createMockStorage(createMockSession(), sandbox);
    const shutdown = createUnmanagedShutdown();
    const manager = createTestLifecycleManager(
      createMockProvider({ takeSnapshot: vi.fn() }),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      shutdown,
      createTestConfig()
    );

    await manager.triggerSnapshot(reason);

    expect(shutdown.captureCheckpoint).toHaveBeenCalledWith(expect.anything(), reason, after);
  });
});

describe("spawn admission race (#1589)", () => {
  // `await hashToken` is a non-storage await, so the DO input gate admits
  // other events while it runs. Whatever the sandbox row says at that moment
  // is what a stale bridge's admission read sees — so the replacement
  // identity, with credentials invalidated, must already be persisted.
  function raceHarness(sandbox: ReturnType<typeof createMockSandbox>) {
    const storage = createMockStorage(createMockSession(), sandbox);
    const manager = createTestLifecycleManager(
      createMockProvider(),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );
    return { storage, manager };
  }

  afterEach(() => {
    // Never leave the gate blocked: hashToken awaits the module-level gate on
    // every call, so a failed mid-window assertion would otherwise hang every
    // later test that spawns.
    releaseHashTokenGate();
    hashTokenGate = Promise.resolve();
  });

  it("fresh spawn: reserves the new identity before hashing opens the input gate", async () => {
    const sandbox = createMockSandbox({
      status: "failed",
      modal_sandbox_id: "sb-old",
      auth_token_hash: "old-hash",
    });
    const { storage, manager } = raceHarness(sandbox);

    blockNextHashToken();
    const hashCallsBefore = vi.mocked(hashToken).mock.calls.length;
    const spawn = manager.spawnSandbox();
    // Call history spans the whole file, so wait for the count to rise: THIS
    // spawn has then provably reached the gated hash — with the phase-1
    // reservation, which precedes it, already persisted.
    await vi.waitFor(() =>
      expect(vi.mocked(hashToken).mock.calls.length).toBeGreaterThan(hashCallsBefore)
    );

    // Mid-window view — what a stale bridge authenticating right now reads.
    expect(sandbox.modal_sandbox_id).not.toBe("sb-old");
    expect(sandbox.auth_token_hash).toBe("");
    expect(sandbox.status).toBe("spawning");

    releaseHashTokenGate();
    await spawn;

    // Phase 2 published the real hash after the identity reservation.
    expect(sandbox.auth_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.calls.indexOf("updateSandboxForSpawn")).toBeLessThan(
      storage.calls.indexOf("updateSandboxAuthTokenHash")
    );
  });

  it("snapshot restore: reserves the new identity before hashing opens the input gate", async () => {
    const sandbox = createMockSandbox({
      status: "stopped",
      modal_sandbox_id: "sb-old",
      auth_token_hash: "old-hash",
      snapshot_image_id: "img-abc123",
      snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      created_at: Date.now() - 60000,
    });
    const { storage, manager } = raceHarness(sandbox);

    blockNextHashToken();
    const hashCallsBefore = vi.mocked(hashToken).mock.calls.length;
    const spawn = manager.spawnSandbox();
    // Call history spans the whole file, so wait for the count to rise: THIS
    // spawn has then provably reached the gated hash — with the phase-1
    // reservation, which precedes it, already persisted.
    await vi.waitFor(() =>
      expect(vi.mocked(hashToken).mock.calls.length).toBeGreaterThan(hashCallsBefore)
    );

    expect(sandbox.modal_sandbox_id).not.toBe("sb-old");
    expect(sandbox.auth_token_hash).toBe("");
    expect(sandbox.status).toBe("spawning");

    releaseHashTokenGate();
    await spawn;

    expect(sandbox.auth_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.calls.indexOf("updateSandboxForSpawn")).toBeLessThan(
      storage.calls.indexOf("updateSandboxAuthTokenHash")
    );
  });

  it("abandons the attempt without failure writes when the reservation is superseded", async () => {
    const sandbox = createMockSandbox({ status: "failed" });
    const { storage, manager } = raceHarness(sandbox);
    vi.mocked(storage.updateSandboxAuthTokenHash).mockReturnValue(false);

    await manager.spawnSandbox();

    // The row and circuit breaker describe the newer reservation now — the
    // superseded attempt must not mark them failed on its way out.
    expect(sandbox.status).toBe("spawning");
    expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
    expect(storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
    expect(storage.setLastSpawnError).not.toHaveBeenCalledWith(
      expect.stringContaining("superseded"),
      expect.anything()
    );
  });
});
