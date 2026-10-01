import { describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG, type SandboxShutdownLifecycle } from "./manager";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION } from "../runtime-manifest";
import type { SandboxProvider, ResumeResult } from "../provider";
import { mintJwt } from "../../auth/jwt";
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
  noLifetime,
} from "./test-helpers";
import { SandboxShutdownCoordinator } from "../../session/sandbox-shutdown";
import type { ShutdownRecord } from "../../session/sandbox-shutdown-repository";

function parseStructuredLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>
  );
}

describe("final graceful shutdown lifecycle integration", () => {
  function fixture(
    provider = createMockProvider(),
    sandbox = createMockSandbox({ status: "stopped" }),
    session = createMockSession()
  ) {
    const storage = createMockStorage(session, sandbox);
    const sockets = createMockWebSocketManager();
    const broadcaster = createMockBroadcaster();
    const shutdown = {
      ...createUnmanagedShutdown(),
      requestShutdown: vi.fn<SandboxShutdownLifecycle["requestShutdown"]>(async () => "owned"),
    };
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      sockets,
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      shutdown,
      createTestConfig()
    );
    return { manager, shutdown, storage, provider, sockets, broadcaster };
  }

  function withSavedState(f: ReturnType<typeof fixture>, kind: "snapshot" | "retained") {
    const row = f.storage.getSandbox()!;
    let state: ShutdownRecord = {
      phase: "saved",
      generation: { sandboxId: row.modal_sandbox_id!, createdAt: row.created_at! },
      provider: f.provider.name,
      providerObjectId: row.modal_object_id,
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: true,
      receipt: {
        kind,
        provider: f.provider.name,
        artifactId: kind === "snapshot" ? "saved-image" : row.modal_object_id!,
        runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
        savedAtMs: Date.now(),
      },
    };
    const shutdown = new SandboxShutdownCoordinator({
      store: {
        read: () => structuredClone(state),
        write: (next: ShutdownRecord) => {
          state = structuredClone(next);
        },
      },
      provider: f.provider,
      sandbox: f.storage,
      session: {
        getSession: () => f.storage.getSession(),
        transaction: <T>(operation: () => T): T => operation(),
      },
      messenger: f.broadcaster,
      sockets: { getSandboxSocket: () => null },
      alarm: createMockAlarmScheduler(),
      background: { submit: vi.fn() },
      retireAccess: vi.fn(),
    } as never);
    f.manager = createTestLifecycleManager(
      f.provider,
      f.storage,
      f.storage,
      f.broadcaster,
      f.sockets,
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      shutdown,
      createTestConfig()
    );
    return { shutdown, read: () => state };
  }

  describe.each(["restore", "resume"] as const)("committed saved %s", (kind) => {
    it.each([
      ["access", "connecting"],
      ["access", "ready"],
      ["publication", "connecting"],
      ["publication", "ready"],
    ] as const)(
      "retains %s failures on a %s sandbox without a recovery hold",
      async (failure, status) => {
        const sandbox = createMockSandbox({
          status: "stopped",
          ttyd_token: await mintJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, "saved-auth-key"),
        });
        const result = {
          providerObjectId: "committed-source",
          lifetime: noLifetime(),
          codeServerUrl: "https://code.test/committed",
          codeServerPassword: "committed-code-secret",
          vncAccess: { url: "https://vnc.test/committed", password: "committed-vnc-secret" },
          tunnelUrls: { "3000": "https://preview.test/committed" },
          ttydUrl: "https://terminal.test/committed",
        };
        const provider = createMockProvider({
          capabilities: { supportsPersistentResume: kind === "resume" },
          restoreFromSnapshot: vi.fn(async (config) => {
            if (status === "ready") sandbox.status = "ready";
            return { success: true as const, sandboxId: config.sandboxId, ...result };
          }),
          resumeSandbox: vi.fn(async () => {
            if (status === "ready") sandbox.status = "ready";
            return { success: true as const, ...result };
          }),
          stopSandbox: vi.fn(async () => ({ success: true })),
        });
        const f = fixture(
          provider,
          sandbox,
          createMockSession({
            code_server_enabled: 1,
            vnc_enabled: 1,
            sandbox_settings: JSON.stringify({ terminalEnabled: true }),
          })
        );
        vi.mocked(f.sockets.getSandboxWebSocket).mockImplementation(() =>
          sandbox.status === "ready" ? ({} as WebSocket) : null
        );
        const saved = withSavedState(f, kind === "restore" ? "snapshot" : "retained");
        const holdFailedRecovery = vi.spyOn(saved.shutdown, "holdFailedRecovery");
        const recordProviderStartup = vi.spyOn(saved.shutdown, "recordProviderStartup");
        const error = new Error(`committed ${failure} failed`);
        let rejectAccess: ((error: Error) => void) | undefined;
        if (failure === "access") {
          const write = new Promise<never>((_resolve, reject) => {
            rejectAccess = reject;
          });
          if (kind === "restore") {
            const persist = vi.mocked(f.storage.updateSandboxAccess).getMockImplementation()!;
            vi.mocked(f.storage.updateSandboxAccess).mockImplementation(
              async (artifact, url, secret) => {
                if (artifact === "ttyd") return write;
                await persist(artifact, url, secret);
              }
            );
          } else {
            vi.mocked(f.storage.completeProviderResume).mockReturnValueOnce(write);
          }
        } else {
          const broadcast = vi.mocked(f.broadcaster.broadcast).getMockImplementation()!;
          vi.mocked(f.broadcaster.broadcast).mockImplementation((message) => {
            if (message.type === "sandbox_access_changed" && saved.read().phase === "running")
              throw error;
            broadcast(message);
          });
        }
        const info = vi.spyOn(console, "log").mockImplementation(() => {});
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const spawning = f.manager.spawnSandbox();
        try {
          if (failure === "access") {
            await vi.waitFor(() => {
              if (kind === "restore")
                expect(f.storage.updateSandboxAccess).toHaveBeenCalledWith(
                  "ttyd",
                  result.ttydUrl,
                  expect.any(String)
                );
              else expect(f.storage.completeProviderResume).toHaveBeenCalledOnce();
            });
            expect(f.manager.isSpawning()).toBe(true);
            expect(sandbox.status).toBe(status);
            expect(saved.read().phase).toBe(kind === "restore" ? "running" : "restoring");
            expect(holdFailedRecovery).not.toHaveBeenCalled();
            rejectAccess!(error);
          }
          await expect(spawning).resolves.toBeUndefined();

          expect(sandbox.status).toBe(status);
          expect(sandbox.modal_object_id).toBe(result.providerObjectId);
          expect(saved.read()).toMatchObject({
            phase: "running",
            sourceRetired: false,
            providerObjectId: result.providerObjectId,
            generation: { sandboxId: sandbox.modal_sandbox_id, createdAt: sandbox.created_at },
            receipt: { kind: kind === "restore" ? "snapshot" : "retained" },
          });
          expect(saved.shutdown.isHolding()).toBe(false);
          expect(recordProviderStartup).toHaveBeenCalledExactlyOnceWith(
            { sandboxId: sandbox.modal_sandbox_id, createdAt: sandbox.created_at },
            result.lifetime
          );
          expect(holdFailedRecovery).not.toHaveBeenCalled();
          expect(f.storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
          expect(f.storage.setLastSpawnError).toHaveBeenCalledExactlyOnceWith(null, null);
          expect(f.storage.transitionSandboxStatus).not.toHaveBeenCalled();
          expect(f.provider.createSandbox).not.toHaveBeenCalled();
          expect(f.provider.stopSandbox).not.toHaveBeenCalled();
          expect(f.broadcaster.messages).not.toContainEqual({
            type: "sandbox_status",
            status: "failed",
          });
          expect(f.broadcaster.messages).not.toContainEqual({
            type: "sandbox_error",
            error: error.message,
          });
          expect(f.broadcaster.messages).not.toContainEqual({
            type: "sandbox_restored",
            message: "Session restored from snapshot",
          });
          expect(parseStructuredLogs(info)).not.toContainEqual(
            expect.objectContaining({ event: "sandbox.restore" })
          );
          expect(errors).not.toHaveBeenCalled();
          expect(parseStructuredLogs(warn)).toContainEqual(
            expect.objectContaining({
              event: "sandbox.recovery_access_failed",
              msg:
                kind === "restore"
                  ? "Restored sandbox access/publication failed"
                  : "Resumed sandbox access/publication failed",
            })
          );
          expect(f.manager.isSpawning()).toBe(false);
          expect(f.manager.isProviderStartupPending()).toBe(false);
        } finally {
          rejectAccess?.(error);
          await spawning;
          info.mockRestore();
          errors.mockRestore();
          warn.mockRestore();
          holdFailedRecovery.mockRestore();
          recordProviderStartup.mockRestore();
        }
      }
    );
  });

  it("holds saved resume when its terminal secret read fails before startup is committed", async () => {
    const f = fixture(
      createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true as const,
          lifetime: noLifetime(),
          ttydUrl: "https://terminal.test/resumed",
        })),
      }),
      createMockSandbox({ status: "stopped", modal_object_id: "retained-source" }),
      createMockSession({ sandbox_settings: JSON.stringify({ terminalEnabled: true }) })
    );
    const saved = withSavedState(f, "retained");
    const holdFailedRecovery = vi.spyOn(saved.shutdown, "holdFailedRecovery");
    const recordProviderStartup = vi.spyOn(saved.shutdown, "recordProviderStartup");
    vi.mocked(f.storage.getSandboxAccessSecret).mockRejectedValue(new Error("secret read failed"));
    try {
      await expect(f.manager.spawnSandbox()).resolves.toBeUndefined();

      expect(f.provider.resumeSandbox).toHaveBeenCalledOnce();
      expect(f.storage.completeProviderResume).not.toHaveBeenCalled();
      expect(recordProviderStartup).not.toHaveBeenCalled();
      expect(holdFailedRecovery).toHaveBeenCalledExactlyOnceWith("secret read failed", {
        sandboxId: f.storage.getSandbox()!.modal_sandbox_id,
        createdAt: f.storage.getSandbox()!.created_at,
      });
      expect(f.storage.getSandbox()).toMatchObject({
        status: "failed",
        modal_object_id: "retained-source",
        last_spawn_error: "secret read failed",
      });
      expect(saved.read()).toMatchObject({
        phase: "unknown",
        sourceRetired: false,
        receipt: { kind: "retained", artifactId: "retained-source" },
      });
      expect(saved.shutdown.isHolding()).toBe(true);
      expect(f.storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
      await f.manager.spawnSandbox();
      expect(f.provider.resumeSandbox).toHaveBeenCalledOnce();
      expect(f.provider.createSandbox).not.toHaveBeenCalled();
    } finally {
      holdFailedRecovery.mockRestore();
      recordProviderStartup.mockRestore();
    }
  });

  it("allows explicit saved-state retry after restore preflight fails without provider I/O", async () => {
    const f = fixture();
    const saved = withSavedState(f, "snapshot");
    vi.mocked(f.storage.getUserEnvVars).mockRejectedValueOnce(
      new Error("temporary secrets failure")
    );

    await f.manager.spawnSandbox();

    expect(f.provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(saved.read()).toMatchObject({ phase: "unknown", sourceRetired: true });
    await f.manager.spawnSandbox();
    expect(f.provider.restoreFromSnapshot).not.toHaveBeenCalled();

    await saved.shutdown.recover("restore_saved");
    expect(saved.read().phase).toBe("saved");
    await f.manager.spawnSandbox();
    expect(f.provider.restoreFromSnapshot).toHaveBeenCalledOnce();
    expect(saved.read()).toMatchObject({ phase: "running", sourceRetired: false });
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("retires an ambiguously resumed retained object before explicitly retrying it", async () => {
    const resumeSandbox = vi
      .fn<NonNullable<SandboxProvider["resumeSandbox"]>>()
      .mockRejectedValueOnce(new Error("provider response lost"))
      .mockResolvedValue({ success: true, lifetime: { kind: "none", observedAtMs: Date.now() } });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const f = fixture(
      createMockProvider({
        resumeSandbox,
        stopSandbox,
        capabilities: { supportsPersistentResume: true, supportsExplicitStop: true },
      })
    );
    const saved = withSavedState(f, "retained");

    await f.manager.spawnSandbox();
    expect(saved.read()).toMatchObject({
      phase: "unknown",
      sourceRetired: false,
      providerObjectId: "modal-obj-123",
    });
    await f.manager.spawnSandbox();
    expect(resumeSandbox).toHaveBeenCalledOnce();

    await saved.shutdown.recover("restore_saved");
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        providerObjectId: "modal-obj-123",
        intent: "preserve",
      })
    );
    expect(saved.read()).toMatchObject({ phase: "saved", sourceRetired: true });
    await f.manager.spawnSandbox();
    expect(resumeSandbox).toHaveBeenCalledTimes(2);
    expect(saved.read()).toMatchObject({ phase: "running", sourceRetired: false });
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it.each(["connect timeout", "fatal runtime error", "boot budget"] as const)(
    "holds a resumed retained source after a %s instead of deleting it",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const resumeSandbox = vi.fn(async () => ({
          success: true as const,
          providerObjectId: "retained-source",
          lifetime: noLifetime(),
          ttydUrl: "https://terminal.test/resumed",
        }));
        const stopSandbox = vi.fn(async () => ({ success: true }));
        const f = fixture(
          createMockProvider({
            resumeSandbox,
            stopSandbox,
            capabilities: { supportsPersistentResume: true, supportsExplicitStop: true },
          }),
          createMockSandbox({
            status: "stopped",
            modal_object_id: "retained-source",
            // The repository clears this on resume; the mock does not.
            last_heartbeat: null,
            ttyd_token: await mintJwt(
              { exp: Math.floor(Date.now() / 1000) - 1 },
              "sandbox-auth-token"
            ),
          }),
          createMockSession({ sandbox_settings: JSON.stringify({ terminalEnabled: true }) })
        );
        const saved = withSavedState(f, "retained");

        await f.manager.spawnSandbox();
        expect(saved.read().phase).toBe("running");
        const row = f.storage.getSandbox()!;
        if (failure === "fatal runtime error") {
          row.last_heartbeat = Date.now();
          expect(await f.manager.terminateFailedSandbox("runtime failed")).toBe(false);
        } else {
          vi.advanceTimersByTime(
            failure === "connect timeout"
              ? DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 1
              : DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs + 1
          );
          if (failure === "boot budget") row.last_heartbeat = Date.now();
          expect(await f.manager.handleShutdownAlarm()).toBe("continue");
          await f.manager.handleAlarm();
        }

        // Neither deleted nor fenced: the source is the only copy of the workspace.
        expect(stopSandbox).not.toHaveBeenCalled();
        expect(row).toMatchObject({
          status: "failed",
          modal_object_id: "retained-source",
          fenced: 0,
        });
        expect(saved.read()).toMatchObject({
          phase: "unknown",
          receipt: { kind: "retained", artifactId: "retained-source" },
        });
        await f.manager.spawnSandbox();
        expect(f.provider.createSandbox).not.toHaveBeenCalled();

        await saved.shutdown.recover("restore_saved");
        expect(stopSandbox).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ providerObjectId: "retained-source", intent: "preserve" })
        );
        await f.manager.spawnSandbox();
        expect(resumeSandbox).toHaveBeenCalledTimes(2);
        expect(saved.read().phase).toBe("running");
        expect(f.provider.createSandbox).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("keeps restore available after a later ordinary resume of the retained source fails mid-resume", async () => {
    let finishResume!: (result: ResumeResult) => void;
    const resumed = {
      success: true as const,
      providerObjectId: "retained-source",
      lifetime: noLifetime(),
    };
    const resumeSandbox = vi
      .fn<NonNullable<SandboxProvider["resumeSandbox"]>>()
      .mockResolvedValueOnce(resumed)
      .mockReturnValueOnce(new Promise((resolve) => (finishResume = resolve)))
      .mockResolvedValue(resumed);
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const f = fixture(
      createMockProvider({
        resumeSandbox,
        stopSandbox,
        capabilities: { supportsPersistentResume: true, supportsExplicitStop: true },
      }),
      createMockSandbox({ status: "stopped", modal_object_id: "retained-source" })
    );
    const saved = withSavedState(f, "retained");
    await f.manager.spawnSandbox();
    // A heartbeat timeout preserve-stops it; the shutdown record stays running.
    const row = f.storage.getSandbox()!;
    row.status = "stopped";

    const ordinaryResume = f.manager.spawnSandbox();
    await vi.waitFor(() => expect(resumeSandbox).toHaveBeenCalledTimes(2));
    row.last_heartbeat = Date.now();
    expect(await f.manager.terminateFailedSandbox("runtime failed")).toBe(false);
    finishResume(resumed);
    await ordinaryResume;

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(saved.read()).toMatchObject({ phase: "unknown", providerObjectId: "retained-source" });
    expect(saved.shutdown.snapshot()?.availableRecoveryActions).toContain("restore_saved");
    await saved.shutdown.recover("restore_saved");
    expect(stopSandbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerObjectId: "retained-source", intent: "preserve" })
    );
    await f.manager.spawnSandbox();
    expect(resumeSandbox).toHaveBeenCalledTimes(3);
    expect(saved.read().phase).toBe("running");
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("allows only explicit retry of an ambiguous snapshot restore from a retired source", async () => {
    const restoreFromSnapshot = vi
      .fn<NonNullable<SandboxProvider["restoreFromSnapshot"]>>()
      .mockRejectedValueOnce(new Error("provider response lost"))
      .mockResolvedValue({
        success: true,
        sandboxId: "restored-sandbox",
        providerObjectId: "restored-source",
        lifetime: { kind: "none", observedAtMs: Date.now() },
      });
    const f = fixture(createMockProvider({ restoreFromSnapshot }));
    const saved = withSavedState(f, "snapshot");

    await f.manager.spawnSandbox();
    expect(saved.read()).toMatchObject({ phase: "unknown", sourceRetired: true });
    await f.manager.spawnSandbox();
    expect(saved.read()).toMatchObject({
      phase: "unknown",
      receipt: { artifactId: "saved-image" },
    });
    expect(restoreFromSnapshot).toHaveBeenCalledOnce();
    expect(saved.shutdown.snapshot()).toMatchObject({
      availableRecoveryActions: ["restore_saved"],
      discardAvailable: true,
    });
    await saved.shutdown.recover("restore_saved");
    await f.manager.spawnSandbox();
    expect(restoreFromSnapshot).toHaveBeenCalledTimes(2);
    expect(saved.read()).toMatchObject({ phase: "running", sourceRetired: false });
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("does not run generic termination or replacement while shutdown owns the source", async () => {
    const f = fixture(
      createMockProvider({
        stopSandbox: vi.fn(async () => ({ success: true })),
        capabilities: { supportsExplicitStop: true },
      }),
      createMockSandbox()
    );
    f.shutdown.isHolding.mockReturnValue(true);
    f.shutdown.startupDecision.mockReturnValue({
      kind: "hold",
      reason: "shutdown in progress",
    });
    await f.manager.terminateUnresponsiveSandbox("stop_confirmation_timeout");
    expect(await f.manager.terminateFailedSandbox("runtime failed")).toBe(false);
    expect(await f.manager.handleAlarm()).toBe("no_action");
    await f.manager.spawnSandbox();
    expect(f.provider.stopSandbox).not.toHaveBeenCalled();
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("saves an archived session's sandbox through graceful shutdown", async () => {
    const f = fixture(
      createMockProvider({ capabilities: { snapshotRequiresShutdown: true } }),
      createMockSandbox({ status: "ready" })
    );
    await f.manager.preserveForArchive();
    expect(f.shutdown.requestShutdown).toHaveBeenCalledExactlyOnceWith("session_archived");
  });

  it("keeps a sandbox whose snapshots stop it running after a finished turn", async () => {
    const sandbox = createMockSandbox({ status: "ready" });
    const f = fixture(
      createMockProvider({ capabilities: { snapshotRequiresShutdown: true } }),
      sandbox
    );
    await f.manager.triggerSnapshot("execution_complete");
    expect(f.shutdown.requestShutdown).not.toHaveBeenCalled();
    expect(f.shutdown.captureCheckpoint).not.toHaveBeenCalled();
    expect(f.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("ready");
  });

  it("routes other destructive snapshots through confirmed graceful shutdown", async () => {
    const f = fixture(createMockProvider({ capabilities: { snapshotRequiresShutdown: true } }));
    await f.manager.triggerSnapshot("inactivity_timeout");
    expect(f.shutdown.requestShutdown).toHaveBeenCalledWith("inactivity_timeout");
    expect(f.provider.takeSnapshot).not.toHaveBeenCalled();
  });

  it("does not fall through to a destructive checkpoint when shutdown declines it", async () => {
    const sandbox = createMockSandbox({ status: "ready" });
    const f = fixture(
      createMockProvider({ capabilities: { snapshotRequiresShutdown: true } }),
      sandbox
    );
    f.shutdown.requestShutdown.mockResolvedValue("held");

    await f.manager.triggerSnapshot("inactivity_timeout");

    expect(f.shutdown.requestShutdown).toHaveBeenCalledWith("inactivity_timeout");
    expect(f.shutdown.captureCheckpoint).not.toHaveBeenCalled();
    expect(f.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("ready");
  });

  it("restores an independent final receipt instead of preferring an expired persistent source", async () => {
    const f = fixture(
      createMockProvider({
        resumeSandbox: vi.fn(),
        capabilities: { supportsPersistentResume: true },
      })
    );
    f.shutdown.startupDecision.mockReturnValue({
      kind: "restore_snapshot",
      snapshotId: "final-image",
      runtimeVersion: "v62-compatible",
    });
    await f.manager.spawnSandbox();
    expect(f.provider.restoreFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotImageId: "final-image" })
    );
    expect(f.provider.resumeSandbox).not.toHaveBeenCalled();
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
    expect(f.shutdown.reserveStartup).toHaveBeenCalledWith(
      expect.any(Number),
      "legacy",
      expect.any(Function)
    );
  });

  it.each([
    ["v62-compatible", "legacy"],
    ["v70-before-shutdown", "legacy"],
    [`v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION}-confirmed`, "confirmed"],
  ] as const)("restores snapshot runtime %s with %s policy", async (runtimeVersion, policy) => {
    const f = fixture(
      createMockProvider(),
      createMockSandbox({
        status: "stopped",
        snapshot_image_id: "existing-image",
        snapshot_runtime_version: runtimeVersion,
      })
    );

    await f.manager.spawnSandbox();

    expect(f.provider.restoreFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotImageId: "existing-image" })
    );
    expect(f.shutdown.reserveStartup).toHaveBeenCalledWith(
      expect.any(Number),
      policy,
      expect.any(Function)
    );
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    [null, "legacy"],
    ["v70-before-shutdown", "legacy"],
    [`v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION}-confirmed`, "confirmed"],
  ] as const)("resumes retained runtime %s with %s policy", async (runtimeVersion, policy) => {
    const f = fixture(
      createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({ success: true as const, lifetime: noLifetime() })),
      }),
      createMockSandbox({
        status: "stopped",
        modal_object_id: "retained-source",
        runtime_version: runtimeVersion,
      })
    );

    await f.manager.spawnSandbox();

    expect(f.provider.resumeSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "retained-source" })
    );
    expect(f.shutdown.reserveStartup).toHaveBeenCalledWith(
      expect.any(Number),
      policy,
      expect.any(Function)
    );
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("does not silently create a fresh sandbox after retained final resume fails", async () => {
    const f = fixture(
      createMockProvider({
        resumeSandbox: vi.fn(async () => ({
          success: false as const,
          shouldSpawnFresh: true,
          error: "missing",
        })),
        capabilities: { supportsPersistentResume: true },
      })
    );
    f.shutdown.startupDecision.mockReturnValue({
      kind: "resume_retained",
      providerObjectId: "retained-source",
      runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
    });
    await f.manager.spawnSandbox();
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
    expect(f.shutdown.holdFailedRecovery).toHaveBeenCalledWith(
      "missing",
      expect.objectContaining({
        createdAt: f.shutdown.reserveStartup.mock.calls[0][0],
      })
    );
  });

  it("does not silently create a fresh sandbox when retained final resume is unsupported", async () => {
    const f = fixture(createMockProvider({ capabilities: { supportsPersistentResume: true } }));
    f.shutdown.startupDecision.mockReturnValue({
      kind: "resume_retained",
      providerObjectId: "retained-source",
      runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
    });

    await f.manager.spawnSandbox();

    expect(f.provider.createSandbox).not.toHaveBeenCalled();
    expect(f.shutdown.holdFailedRecovery).toHaveBeenCalledWith(
      expect.stringContaining("cannot resume")
    );
  });

  it("retains incompatible and foreign-provider receipts without fresh fallback", async () => {
    const f = fixture();
    f.shutdown.startupDecision.mockReturnValue({
      kind: "hold",
      reason: "provider mismatch",
    });
    await f.manager.spawnSandbox();
    f.shutdown.startupDecision.mockReturnValue({
      kind: "restore_snapshot",
      snapshotId: "final-image",
      runtimeVersion: "0.0.0",
    });
    await f.manager.spawnSandbox();
    expect(f.shutdown.holdFailedRecovery).toHaveBeenCalledOnce();
    expect(f.provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(f.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("publishes the actual provider lifetime for the reserved generation", async () => {
    const lifetime = {
      kind: "finite" as const,
      expiresAtMs: Date.now() + 900_000,
      observedAtMs: Date.now(),
      source: "provider" as const,
    };
    const f = fixture(
      createMockProvider({
        createSandbox: vi.fn(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-new",
          status: "connecting",
          createdAt: Date.now(),
          lifetime,
        })),
      }),
      createMockSandbox({ status: "pending" })
    );
    await f.manager.spawnSandbox();
    const generation = f.shutdown.recordProviderStartup.mock.calls[0]?.[0];
    expect(generation).toEqual(
      expect.objectContaining({ sandboxId: expect.any(String), createdAt: expect.any(Number) })
    );
    expect(f.shutdown.recordProviderStartup).toHaveBeenCalledWith(generation, lifetime);
  });

  it.each([null, "0.0.0"])(
    "resumes retained legacy runtime %s without fresh fallback",
    async (runtimeVersion) => {
      const f = fixture(
        createMockProvider({
          resumeSandbox: vi.fn(async () => ({
            success: true as const,
            lifetime: noLifetime(),
          })),
        })
      );
      f.storage.getSandbox()!.runtime_version = `v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION}-different-row`;
      f.shutdown.startupDecision.mockReturnValue({
        kind: "resume_retained",
        providerObjectId: "retained-source",
        runtimeVersion,
      });
      await f.manager.spawnSandbox();
      expect(f.provider.resumeSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ providerObjectId: "retained-source" })
      );
      expect(f.shutdown.reserveStartup).toHaveBeenCalledWith(
        expect.any(Number),
        "legacy",
        expect.any(Function)
      );
      expect(f.storage.getSandbox()!.runtime_version).toBe(runtimeVersion);
      expect(f.shutdown.holdFailedRecovery).not.toHaveBeenCalled();
      expect(f.provider.createSandbox).not.toHaveBeenCalled();
    }
  );

  it.each(["returned", "thrown"] as const)(
    "holds an ordinary snapshot restore failure when %s instead of retrying ambiguously",
    async (failureKind) => {
      const restoreFromSnapshot =
        failureKind === "returned"
          ? vi.fn(async () => ({ success: false as const, error: "ordinary restore failed" }))
          : vi.fn(async () => {
              throw new Error("ordinary restore failed");
            });
      const f = fixture(
        createMockProvider({ restoreFromSnapshot }),
        createMockSandbox({
          status: "stopped",
          snapshot_image_id: "ordinary-image",
          snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
        })
      );

      await f.manager.spawnSandbox();

      expect(restoreFromSnapshot).toHaveBeenCalled();
      expect(f.shutdown.holdFailedRecovery).toHaveBeenCalledWith(
        "ordinary restore failed",
        expect.objectContaining({ sandboxId: expect.any(String) })
      );
    }
  );

  it("does not report an ordinary retained resume failure as final graceful shutdown", async () => {
    const resumeSandbox = vi.fn(async () => ({
      success: false as const,
      error: "ordinary resume failed",
    }));
    const f = fixture(
      createMockProvider({
        resumeSandbox,
        capabilities: { supportsPersistentResume: true },
      }),
      createMockSandbox({
        status: "stopped",
        modal_object_id: "ordinary-retained-source",
      })
    );

    await f.manager.spawnSandbox();

    expect(resumeSandbox).toHaveBeenCalled();
    expect(f.shutdown.holdFailedRecovery).not.toHaveBeenCalled();
  });
});
