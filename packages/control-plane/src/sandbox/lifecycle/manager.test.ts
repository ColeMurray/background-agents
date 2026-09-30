/**
 * Unit tests for SandboxLifecycleManager.
 *
 * Uses mocked dependencies to test lifecycle orchestration logic.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type AlarmScheduler,
  type SandboxShutdownLifecycle,
} from "./manager";
import type { McpServerLookup, SlackAgentNotifyLookup } from "./launch-context";
import type { ImageBuildLookup, ImageBuildSpawnRow } from "./image-selection";
import { SandboxAccess, TERMINAL_TOKEN_TTL_SECONDS } from "./sandbox-access";
import { createLogger } from "../../logger";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION } from "../runtime-manifest";
import {
  PrebuiltImageActivationPendingError,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  SandboxLaunchRejectedError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeResult,
  type SessionRepositoryInfo,
  type StopResult,
} from "../provider";
import type { SandboxRow, SessionRow } from "../../session/types";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import { hashToken } from "../../auth/crypto";
import { mintJwt } from "../../auth/jwt";
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

function parseStructuredLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>
  );
}

type ProviderStartupKind = "spawn" | "restore" | "resume";

async function expectEarlyBridgeStartup(kind: ProviderStartupKind): Promise<void> {
  const sandbox = createMockSandbox({
    status: kind === "spawn" ? "pending" : "stopped",
    created_at: Date.now() - 60000,
    snapshot_image_id: kind === "restore" ? "img-abc123" : null,
    snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
  });
  const storage = createMockStorage(
    createMockSession({ code_server_enabled: 1, vnc_enabled: 1 }),
    sandbox
  );
  const broadcaster = createMockBroadcaster();
  const wsManager = createMockWebSocketManager(false);
  const alarmScheduler = createMockAlarmScheduler();
  const accessAtBroadcast: Array<
    Pick<
      SandboxRow,
      "code_server_url" | "code_server_password" | "vnc_url" | "vnc_password" | "tunnel_urls"
    >
  > = [];
  vi.mocked(broadcaster.broadcast).mockImplementation((message: object) => {
    broadcaster.messages.push(message);
    if ((message as { type?: string }).type === "sandbox_access_changed") {
      accessAtBroadcast.push({
        code_server_url: sandbox.code_server_url,
        code_server_password: sandbox.code_server_password,
        vnc_url: sandbox.vnc_url,
        vnc_password: sandbox.vnc_password,
        tunnel_urls: sandbox.tunnel_urls,
      });
    }
  });
  const connectBridge = () => {
    expect(alarmScheduler.alarms).toHaveLength(1);
    sandbox.status = "ready";
    vi.mocked(wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    broadcaster.broadcast({ type: "sandbox_status", status: "ready" });
  };
  const access = {
    codeServerUrl: `https://${kind}-code.test`,
    codeServerPassword: `${kind}-code-secret`,
    vncAccess: { url: `https://${kind}-vnc.test`, password: `${kind}-vnc-secret` },
    tunnelUrls: { "3000": `https://${kind}-preview.test` },
  };
  const provider = createMockProvider({
    capabilities: { supportsPersistentResume: kind === "resume" },
    createSandbox: vi.fn(async (config) => {
      connectBridge();
      return {
        sandboxId: config.sandboxId,
        status: "connecting",
        createdAt: Date.now(),
        lifetime: noLifetime(),
        ...access,
      };
    }),
    restoreFromSnapshot: vi.fn(async (config) => {
      connectBridge();
      return {
        success: true as const,
        sandboxId: config.sandboxId,
        lifetime: noLifetime(),
        ...access,
      };
    }),
    resumeSandbox: vi.fn(async () => {
      connectBridge();
      return { success: true as const, lifetime: noLifetime(), ...access };
    }),
  });
  const manager = createTestLifecycleManager(
    provider,
    storage,
    storage,
    broadcaster,
    wsManager,
    alarmScheduler,
    createMockIdGenerator(),
    createUnmanagedShutdown(),
    createTestConfig()
  );

  await manager.spawnSandbox();

  expect(sandbox.status).toBe("ready");
  expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->connecting");
  expect(storage.calls.filter((call) => call === "updateSandboxForResume:connecting")).toHaveLength(
    kind === "resume" ? 1 : 0
  );
  expect(alarmScheduler.alarms).toHaveLength(1);
  expect(manager.isProviderStartupPending()).toBe(false);
  const readyIndex = broadcaster.messages.findIndex(
    (message) =>
      (message as { type?: string; status?: string }).type === "sandbox_status" &&
      (message as { status?: string }).status === "ready"
  );
  expect(broadcaster.messages.slice(readyIndex + 1)).not.toContainEqual({
    type: "sandbox_status",
    status: "connecting",
  });
  expect(
    broadcaster.messages.filter(
      (message) => (message as { type: string }).type === "sandbox_access_changed"
    )
  ).not.toHaveLength(0);
  expect(accessAtBroadcast.at(-1)).toEqual({
    code_server_url: access.codeServerUrl,
    code_server_password: access.codeServerPassword,
    vnc_url: access.vncAccess.url,
    vnc_password: access.vncAccess.password,
    tunnel_urls: JSON.stringify(access.tunnelUrls),
  });
}

// ==================== Tests ====================

describe("lifecycle-owned runtime readiness and cancellation", () => {
  function harness(
    status: SandboxStatus | null,
    attached = true,
    explicitStop = false,
    persistentResume = false
  ) {
    const row = status === null ? null : createMockSandbox({ status });
    const storage = createMockStorage(createMockSession(), row);
    const broadcaster = createMockBroadcaster();
    const ws = createMockWebSocketManager(attached);
    const provider = createMockProvider({
      stopSandbox: vi.fn(async () => ({ success: true })),
      capabilities: {
        supportsExplicitStop: explicitStop,
        supportsPersistentResume: persistentResume,
      },
    });
    const alarms = createMockAlarmScheduler();
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      ws,
      alarms,
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );
    return { manager, row, storage, broadcaster, ws, provider, alarms };
  }

  it.each([
    "pending",
    "spawning",
    "connecting",
    "warming",
    "ready",
    "snapshotting",
    "stale",
  ] as const)(
    "cancels %s by asking the runtime to exit, then stopping it at the provider",
    async (status) => {
      const h = harness(status, true, true);
      await h.manager.cancelSandbox();
      expect(h.ws.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(h.storage.updateSandboxStatus).toHaveBeenCalledWith("stopped");
      expect(vi.mocked(h.ws.sendToSandbox).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(h.storage.updateSandboxStatus).mock.invocationCallOrder[0]
      );
      expect(h.provider.stopSandbox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "session_cancelled",
          intent: "destroy",
        })
      );
      expect(vi.mocked(h.storage.updateSandboxStatus).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(h.provider.stopSandbox!).mock.invocationCallOrder[0]
      );
      expect(h.storage.fenceSandboxGeneration).not.toHaveBeenCalled();
      expect(h.ws.detachSandboxWebSocket).not.toHaveBeenCalled();
      expect(h.broadcaster.messages).toEqual([]);
    }
  );

  it("destroys a resumable provider's sandbox on cancel, since the session never resumes", async () => {
    const h = harness("ready", true, true, true);
    await h.manager.cancelSandbox();
    expect(h.provider.stopSandbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "session_cancelled", intent: "destroy" })
    );
  });

  it("cancels without a provider stop when the provider cannot stop explicitly", async () => {
    const h = harness("ready");
    await h.manager.cancelSandbox();
    expect(h.storage.updateSandboxStatus).toHaveBeenCalledWith("stopped");
    expect(h.provider.stopSandbox).not.toHaveBeenCalled();
  });

  it("still records a cancellation when the provider stop fails", async () => {
    const h = harness("ready", true, true);
    vi.mocked(h.provider.stopSandbox!).mockRejectedValue(new Error("provider unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.manager.cancelSandbox();
    expect(h.row?.status).toBe("stopped");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider unavailable"));
  });

  it.each(["stopped", "failed", null] as const)("leaves %s unchanged on cancel", async (status) => {
    const h = harness(status, true, true);
    await h.manager.cancelSandbox();
    expect(h.ws.getSandboxWebSocket).not.toHaveBeenCalled();
    expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
    expect(h.provider.stopSandbox).not.toHaveBeenCalled();
  });

  it.each(["ready", "stale"] as const)(
    "cancels a %s row without an attached dispatch socket",
    async (status) => {
      const h = harness(status, false);
      await h.manager.cancelSandbox();
      expect(h.ws.sendToSandbox).not.toHaveBeenCalled();
      expect(h.storage.updateSandboxStatus).toHaveBeenCalledWith("stopped");
    }
  );

  it("still records stopped when the existing local shutdown send fails", async () => {
    const h = harness("ready");
    vi.mocked(h.ws.sendToSandbox).mockReturnValue(false);
    await h.manager.cancelSandbox();
    expect(h.row?.status).toBe("stopped");
  });

  it("commits readiness and activity before publishing; leaves queue/scheduling to the caller", () => {
    const h = harness("connecting");
    expect(h.manager.onRuntimeReady(1234, "opencode")).toBe(true);
    expect(h.storage.markSandboxReady).toHaveBeenCalledWith({
      sandboxId: h.row?.modal_sandbox_id,
      createdAt: h.row?.created_at,
    });
    expect(h.storage.updateSandboxLastActivity).toHaveBeenCalledWith(1234);
    expect(vi.mocked(h.storage.markSandboxReady).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.storage.updateSandboxLastActivity).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(h.storage.updateSandboxLastActivity).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.broadcaster.broadcast).mock.invocationCallOrder[0]
    );
    expect(h.broadcaster.messages).toEqual([{ type: "sandbox_status", status: "ready" }]);
    expect(h.alarms.alarms).toEqual([]);
  });

  it("does not publish or update activity when the readiness CAS rejects the attempt", () => {
    const h = harness("connecting");
    vi.mocked(h.storage.markSandboxReady).mockReturnValue(false);
    expect(h.manager.onRuntimeReady(1234)).toBe(false);
    expect(h.storage.updateSandboxLastActivity).not.toHaveBeenCalled();
    expect(h.broadcaster.messages).toEqual([]);
  });

  it("ignores readiness without a current row", () => {
    const h = harness(null);
    expect(h.manager.onRuntimeReady(1234)).toBe(false);
    expect(h.storage.markSandboxReady).not.toHaveBeenCalled();
  });
});

describe("SandboxLifecycleManager", () => {
  it("does not invoke collaborators during construction and honors the injected hold first", async () => {
    const sandbox = createMockSandbox({ status: "pending" });
    const storage = createMockStorage(createMockSession(), sandbox);
    const provider = createMockProvider();
    const shutdown = {
      ...createUnmanagedShutdown(),
      startupDecision: vi.fn(() => ({ kind: "hold" as const, reason: "shutdown held" })),
    } satisfies SandboxShutdownLifecycle;
    const callbacks = {
      broadcast: vi.fn(),
      schedule: vi.fn(async () => undefined),
    };
    const wsManager = createMockWebSocketManager(false);
    const idGenerator = createMockIdGenerator();
    const getSessionId = vi.fn(() => "construction-session");

    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      { broadcast: callbacks.broadcast },
      wsManager,
      { ...createMockAlarmScheduler(), schedule: callbacks.schedule },
      idGenerator,
      shutdown,
      { ...createTestConfig(), getSessionId }
    );

    expect(storage.calls).toEqual([]);
    expect(getSessionId).not.toHaveBeenCalled();
    expect(wsManager.getSandboxWebSocket).not.toHaveBeenCalled();
    expect(idGenerator.generateId).not.toHaveBeenCalled();
    expect(shutdown.startupDecision).not.toHaveBeenCalled();
    expect(callbacks.broadcast).not.toHaveBeenCalled();
    expect(callbacks.schedule).not.toHaveBeenCalled();

    await manager.spawnSandbox();

    expect(shutdown.startupDecision).toHaveBeenCalledOnce();
    expect(storage.calls).toEqual([]);
    expect(getSessionId).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(callbacks.broadcast).not.toHaveBeenCalled();
    expect(callbacks.schedule).not.toHaveBeenCalled();
  });

  describe("spawnSandbox", () => {
    it("spawns when all conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const alarmScheduler = createMockAlarmScheduler();
      const idGenerator = createMockIdGenerator();
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("commitProviderStartup");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_status")
      ).toBe(true);
    });

    it.each(["spawn", "restore"] as const)(
      "stops the prior provider sandbox before %s overwrites its handle",
      async (kind) => {
        const calls: string[] = [];
        const sandbox = createMockSandbox({
          status: kind === "spawn" ? "pending" : "stopped",
          snapshot_image_id: kind === "restore" ? "img-abc123" : null,
          snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
          created_at: Date.now() - 60000,
        });
        const storage = createMockStorage(createMockSession(), sandbox);
        const alarmScheduler = createMockAlarmScheduler();
        vi.mocked(alarmScheduler.schedule).mockImplementation(async (timestamp) => {
          calls.push("alarm");
          alarmScheduler.alarms.push(timestamp);
        });
        vi.mocked(storage.updateSandboxForSpawn).mockImplementation((data) => {
          calls.push("fence");
          sandbox.status = data.status;
          sandbox.auth_token_hash = "";
          sandbox.modal_sandbox_id = data.modalSandboxId;
        });
        vi.mocked(storage.updateSandboxModalObjectId).mockImplementation((id) => {
          calls.push("clear");
          sandbox.modal_object_id = id;
        });
        const stopSandbox = vi.fn(async () => {
          calls.push("stop");
          expect(sandbox.modal_object_id).toBe("modal-obj-123");
          return { success: true };
        });
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox,
        });
        const manager = createTestLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(false),
          alarmScheduler,
          createMockIdGenerator(),
          createUnmanagedShutdown(),
          createTestConfig()
        );

        await manager.spawnSandbox();

        expect(calls.slice(0, 4)).toEqual(["fence", "alarm", "stop", "clear"]);
        expect(stopSandbox).toHaveBeenCalledWith(
          expect.objectContaining({
            providerObjectId: "modal-obj-123",
            sessionId: "test-session",
            reason: "respawn",
            intent: "destroy",
            signal: expect.any(AbortSignal),
          })
        );
        expect(sandbox.modal_object_id).toBeNull();
      }
    );

    it.each(["spawn", "restore"] as const)(
      "continues %s when stopping the prior provider sandbox fails",
      async (kind) => {
        const sandbox = createMockSandbox({
          status: kind === "spawn" ? "pending" : "stopped",
          snapshot_image_id: kind === "restore" ? "img-abc123" : null,
          snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
          created_at: Date.now() - 60000,
        });
        const storage = createMockStorage(createMockSession(), sandbox);
        let providerHandleAtStart: string | null | undefined;
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          createSandbox: vi.fn(async (config) => {
            providerHandleAtStart = sandbox.modal_object_id;
            return {
              sandboxId: config.sandboxId,
              status: "connecting",
              createdAt: Date.now(),
              lifetime: noLifetime(),
            };
          }),
          restoreFromSnapshot: vi.fn(async (config) => {
            providerHandleAtStart = sandbox.modal_object_id;
            return {
              success: true as const,
              sandboxId: config.sandboxId,
              lifetime: noLifetime(),
            };
          }),
          stopSandbox: vi.fn(async () => {
            throw new Error("provider unavailable");
          }),
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
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await manager.spawnSandbox();

        expect(storage.updateSandboxForSpawn).toHaveBeenCalledOnce();
        expect(providerHandleAtStart).toBeNull();
        expect(sandbox.modal_object_id).toBeNull();
        expect(
          kind === "spawn" ? provider.createSandbox : provider.restoreFromSnapshot
        ).toHaveBeenCalledOnce();
        expect(storage.commitProviderStartup).toHaveBeenCalledWith(
          expect.objectContaining({ sandboxId: expect.any(String) }),
          null,
          false
        );
        expect(parseStructuredLogs(warnSpy)).toContainEqual(
          expect.objectContaining({
            msg: "Provider stop failed before sandbox replacement",
            error: "provider unavailable",
          })
        );
        warnSpy.mockRestore();
      }
    );

    it("continues replacement when stopping the prior provider sandbox times out", async () => {
      vi.useFakeTimers();
      try {
        const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
        const storage = createMockStorage(createMockSession(), sandbox);
        let providerHandleAtCreate: string | null | undefined;
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          createSandbox: vi.fn(async (config) => {
            providerHandleAtCreate = sandbox.modal_object_id;
            return {
              sandboxId: config.sandboxId,
              status: "connecting",
              createdAt: Date.now(),
              lifetime: noLifetime(),
            };
          }),
          stopSandbox: vi.fn(() => new Promise<StopResult>(() => {})),
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
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const spawning = manager.spawnSandbox();
        await vi.waitFor(() => expect(provider.stopSandbox).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(10_000);
        await spawning;

        expect(provider.createSandbox).toHaveBeenCalledOnce();
        expect(providerHandleAtCreate).toBeNull();
        expect(storage.commitProviderStartup).toHaveBeenCalledWith(
          expect.objectContaining({ sandboxId: expect.any(String) }),
          null,
          false
        );
        expect(sandbox.modal_object_id).toBeNull();
        expect(parseStructuredLogs(warnSpy)).toContainEqual(
          expect.objectContaining({
            msg: "Provider stop failed before sandbox replacement",
            error: "Provider stop timed out before sandbox replacement",
          })
        );
        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stores VNC access without publishing it before the sandbox is ready", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession({ vnc_enabled: 1 }), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        createSandbox: vi.fn(async (config) => ({
          sandboxId: config.sandboxId,
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
          vncAccess: { url: "https://vnc.test", password: "secret" },
        })),
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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ vncEnabled: true })
      );
      expect(storage.updateSandboxAccess).toHaveBeenCalledWith("vnc", "https://vnc.test", "secret");
      expect(broadcaster.messages).not.toContainEqual({ type: "sandbox_access_changed" });
      expect(JSON.stringify(broadcaster.messages)).not.toContain("secret");
    });

    it.each(["spawn", "restore", "resume"] as const)(
      "preserves an early bridge connection until %s access is persisted",
      expectEarlyBridgeStartup
    );

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

    it("logs one terminal sandbox.spawn event for success", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
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

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const spawnLogs = parseStructuredLogs(logSpy).filter(
        (entry) => entry.msg === "Sandbox spawn completed" && entry.event === "sandbox.spawn"
      );
      logSpy.mockRestore();

      expect(spawnLogs).toHaveLength(1);
      expect(spawnLogs[0]).toEqual(
        expect.objectContaining({
          outcome: "success",
          sandbox_id: expect.any(String),
          provider_object_id: "provider-obj-123",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("logs one terminal sandbox.spawn event for failure", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new Error("spawn exploded");
        }),
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

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const errorLogs = parseStructuredLogs(errorSpy);
      errorSpy.mockRestore();

      expect(errorLogs).toContainEqual(
        expect.objectContaining({
          msg: "Sandbox spawn completed",
          event: "sandbox.spawn",
          outcome: "error",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("logs only an error terminal event when spawn success-side effects fail", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      vi.mocked(storage.updateSandboxModalObjectId).mockImplementation(() => {
        throw new Error("storage unavailable");
      });
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
      const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const terminalLogs = [
        ...parseStructuredLogs(infoSpy),
        ...parseStructuredLogs(errorSpy),
      ].filter((entry) => entry.event === "sandbox.spawn");
      infoSpy.mockRestore();
      errorSpy.mockRestore();

      expect(terminalLogs).toHaveLength(1);
      expect(terminalLogs[0]).toEqual(expect.objectContaining({ outcome: "error" }));
    });

    it("broadcasts sandbox_dashboard_url after spawn when builder is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      await manager.spawnSandbox();

      expect(sandbox.modal_object_id).toBe("provider-obj-123");
      expect(
        broadcaster.messages.filter(
          (m) => (m as { type: string }).type === "sandbox_access_changed"
        )
      ).toContainEqual({ type: "sandbox_access_changed" });
    });

    it("does not broadcast sandbox_dashboard_url when no builder is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();

      const manager = createTestLifecycleManager(
        createMockProvider(),
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

      expect(sandbox.modal_object_id).toBe("provider-obj-123");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_access_changed")
      ).toBe(false);
    });

    it("schedules the connecting timeout from the persisted startup timestamp", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      await manager.spawnSandbox();

      expect(alarmScheduler.alarms).toEqual([
        sandbox.created_at + config.connectingTimeout.timeoutMs,
      ]);
    });

    it("passes user env vars to provider", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const userEnvVars = { DATABASE_URL: "postgres://example" };
      const storage = createMockStorage(createMockSession(), sandbox, userEnvVars);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const alarmScheduler = createMockAlarmScheduler();
      const idGenerator = createMockIdGenerator();
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ userEnvVars }));
    });

    it("spawns no-repository sessions without repo-only sandbox features", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(
        createMockSession({
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
          code_server_enabled: 1,
        }),
        sandbox
      );
      const provider = createMockProvider();
      const mcpServerLookup = {
        getDecryptedForSession: vi.fn(async () => []),
      };
      const slackAgentNotifyLookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => null),
        markRestoreFailed: vi.fn(async () => true),
      };

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        {
          ...createTestConfig(),
          mcpServerLookup,
          slackAgentNotifyLookup,
        },
        imageBuildLookup
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: null,
          repoName: null,
          branch: null,
          codeServerEnabled: true,
          agentSlackNotifyEnabled: true,
          prebuiltImageId: null,
          prebuiltImageSha: null,
        })
      );
      expect(mcpServerLookup.getDecryptedForSession).toHaveBeenCalledWith([]);
      expect(slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledWith(null, null);
      expect(imageBuildLookup.getLatestReady).not.toHaveBeenCalled();
    });

    it("respects circuit breaker blocking", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        spawn_failure_count: 3,
        last_spawn_failure: now - 60000, // 1 minute ago, within 5 min window
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
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

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_error")
      ).toBe(true);
    });

    it("persists the circuit-breaker reason, not just the broadcast", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        spawn_failure_count: 3,
        last_spawn_failure: now - 60000,
      });
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

      await manager.spawnSandbox();

      // Broadcast alone reaches only the tab that is already open; the reason
      // has to be persisted or it vanishes on the reload someone does to read it.
      expect(storage.setLastSpawnError).toHaveBeenCalledWith(
        expect.stringContaining("temporarily disabled"),
        expect.any(Number)
      );
      expect(sandbox.last_spawn_error).toContain("temporarily disabled");
    });

    it("still broadcasts the reason when persisting it throws", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        spawn_failure_count: 3,
        last_spawn_failure: now - 60000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      // setLastSpawnError is a bare synchronous sql.exec in the DO, so
      // this is a real failure mode, not a hypothetical one.
      vi.mocked(storage.setLastSpawnError).mockImplementation(() => {
        throw new Error("storage unavailable");
      });
      const broadcaster = createMockBroadcaster();
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      // Losing durability must not also cost the live broadcast, which is the
      // only signal an already-open tab gets.
      await expect(manager.spawnSandbox()).resolves.toBeUndefined();
      expect(
        broadcaster.messages.some((m) => (m as { type?: string }).type === "sandbox_error")
      ).toBe(true);
    });

    it("resets circuit breaker when window passes", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        created_at: now - 60000,
        spawn_failure_count: 3,
        last_spawn_failure: now - 6 * 60 * 1000, // 6 minutes ago, outside 5 min window
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
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

      expect(storage.calls).toContain("resetCircuitBreaker");
      expect(provider.createSandbox).toHaveBeenCalled();
    });

    it("restores from snapshot when available", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
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

      expect(provider.restoreFromSnapshot).toHaveBeenCalled();
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("passes the current managed provider environment when restoring a snapshot", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const userEnvVars = {
        OPENAI_OAUTH_MANAGED: "1",
        XAI_API_KEY: "xai-key",
      };
      const storage = createMockStorage(createMockSession(), sandbox, userEnvVars);
      const provider = createMockProvider();
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

      expect(storage.getUserEnvVars).toHaveBeenCalledOnce();
      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ userEnvVars })
      );
    });

    it("logs one terminal sandbox.restore event for success", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const mockStorage = createMockStorage(createMockSession(), sandbox);
      const manager = createTestLifecycleManager(
        createMockProvider(),
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const infoLogs = parseStructuredLogs(logSpy);
      logSpy.mockRestore();

      expect(infoLogs).toContainEqual(
        expect.objectContaining({
          msg: "Sandbox restore completed",
          event: "sandbox.restore",
          outcome: "success",
          snapshot_image_id: "img-abc123",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("logs one terminal sandbox.restore event for failure", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(
          async (): Promise<RestoreResult> => ({
            success: false,
            error: "Snapshot not found",
          })
        ),
      });
      const mockStorage = createMockStorage(createMockSession(), sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const errorLogs = parseStructuredLogs(errorSpy);
      errorSpy.mockRestore();

      expect(errorLogs).toContainEqual(
        expect.objectContaining({
          msg: "Sandbox restore completed",
          event: "sandbox.restore",
          outcome: "error",
          snapshot_image_id: "img-abc123",
          error: "Snapshot not found",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("logs only an error terminal event when restore success-side effects fail", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      vi.mocked(storage.updateSandboxModalObjectId).mockImplementation(() => {
        throw new Error("storage unavailable");
      });
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true as const,
          sandboxId: config.sandboxId,
          providerObjectId: "restored-object",
          lifetime: noLifetime(),
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
      const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const terminalLogs = [
        ...parseStructuredLogs(infoSpy),
        ...parseStructuredLogs(errorSpy),
      ].filter((entry) => entry.event === "sandbox.restore");
      infoSpy.mockRestore();
      errorSpy.mockRestore();

      expect(terminalLogs).toHaveLength(1);
      expect(terminalLogs[0]).toEqual(expect.objectContaining({ outcome: "error" }));
    });

    it("stores providerObjectId after successful restore for future snapshots", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true as const,
          sandboxId: config.sandboxId,
          providerObjectId: "new-modal-obj-after-restore",
          lifetime: noLifetime(),
        })),
      });

      const manager = createTestLifecycleManager(
        provider,
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

      // Verify providerObjectId was stored for future snapshots
      expect(sandbox.modal_object_id).toBe("new-modal-obj-after-restore");
    });

    it("broadcasts sandbox_dashboard_url after restore when builder is configured", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true as const,
          sandboxId: config.sandboxId,
          providerObjectId: "restored-obj-456",
          lifetime: noLifetime(),
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      await manager.spawnSandbox();

      expect(sandbox.modal_object_id).toBe("restored-obj-456");
      expect(
        broadcaster.messages.filter(
          (m) => (m as { type: string }).type === "sandbox_access_changed"
        )
      ).toContainEqual({ type: "sandbox_access_changed" });
    });

    it("broadcasts sandbox_dashboard_url after resume when provider object id changes", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "old-provider-obj",
        snapshot_image_id: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true as const,
          providerObjectId: "new-provider-obj",
          lifetime: noLifetime(),
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("completeProviderResume");
      expect(sandbox.modal_object_id).toBe("new-provider-obj");
      expect(
        broadcaster.messages.filter(
          (m) => (m as { type: string }).type === "sandbox_access_changed"
        )
      ).toContainEqual({ type: "sandbox_access_changed" });
    });

    it("broadcasts sandbox_dashboard_url after resume when provider object id is unchanged", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "same-provider-obj",
        snapshot_image_id: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true as const,
          providerObjectId: "same-provider-obj",
          lifetime: noLifetime(),
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("completeProviderResume");
      expect(sandbox.modal_object_id).toBe("same-provider-obj");
      expect(
        broadcaster.messages.filter(
          (m) => (m as { type: string }).type === "sandbox_access_changed"
        )
      ).toContainEqual({ type: "sandbox_access_changed" });
    });

    it("refreshes terminal URL after resume without replacing its token", async () => {
      const ttydToken = await mintJwt(
        { exp: Math.floor(Date.now() / 1000) + 60 },
        "sandbox-auth-token"
      );
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "same-provider-obj",
        snapshot_image_id: null,
        ttyd_url: null,
        ttyd_token: ttydToken,
      });
      const storage = createMockStorage(
        createMockSession({
          code_server_enabled: 1,
          vnc_enabled: 1,
          sandbox_settings: JSON.stringify({ terminalEnabled: true }),
        }),
        sandbox
      );
      const access = {
        codeServerUrl: "https://code.test/resumed",
        codeServerPassword: "resumed-code-secret",
        vncAccess: { url: "https://vnc.test/resumed", password: "resumed-vnc-secret" },
        tunnelUrls: { "3000": "https://preview.test/resumed" },
      };
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true as const,
          providerObjectId: "same-provider-obj",
          lifetime: noLifetime(),
          ttydUrl: "https://terminal.test/refreshed",
          ...access,
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

      expect(sandbox.ttyd_url).toBe("https://terminal.test/refreshed");
      expect(sandbox.ttyd_token).toBe(ttydToken);
      expect(storage.completeProviderResume).toHaveBeenCalledExactlyOnceWith(
        { sandboxId: sandbox.modal_sandbox_id, createdAt: sandbox.created_at },
        {
          providerObjectId: "same-provider-obj",
          codeServer: { url: access.codeServerUrl, password: access.codeServerPassword },
          vnc: access.vncAccess,
          ttyd: { url: "https://terminal.test/refreshed", token: ttydToken },
          tunnelUrls: access.tunnelUrls,
        }
      );
      expect(vi.mocked(storage.completeProviderResume).mock.calls[0]).toHaveLength(2);
      expect(storage.getSandboxAccessSecret).toHaveBeenCalledExactlyOnceWith("ttyd");
      expect(storage.updateSandboxAccess).not.toHaveBeenCalled();
      expect(storage.updateSandboxTunnelUrls).not.toHaveBeenCalled();
      expect(sandbox).toMatchObject({
        code_server_url: access.codeServerUrl,
        code_server_password: access.codeServerPassword,
        vnc_url: access.vncAccess.url,
        vnc_password: access.vncAccess.password,
        tunnel_urls: JSON.stringify(access.tunnelUrls),
      });
    });

    it("does not publish access when a resume is cancelled during the provider request", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "provider-obj",
        snapshot_image_id: null,
      });
      const storage = createMockStorage(createMockSession({ code_server_enabled: 1 }), sandbox);
      const broadcaster = createMockBroadcaster();
      let completeResume!: (result: ResumeResult) => void;
      const resumeResult = new Promise<ResumeResult>((resolve) => {
        completeResume = resolve;
      });
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => resumeResult),
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

      const spawn = manager.spawnSandbox();
      await vi.waitFor(() => expect(provider.resumeSandbox).toHaveBeenCalled());
      sandbox.status = "stopped";
      completeResume({
        success: true,
        lifetime: noLifetime(),
        codeServerUrl: "https://late-code.test",
        codeServerPassword: "late-secret",
      });
      await spawn;

      expect(storage.completeProviderResume).toHaveBeenCalled();
      expect(sandbox.code_server_url).toBeNull();
      expect(broadcaster.messages).not.toContainEqual({ type: "sandbox_access_changed" });
    });

    it.each(["missing", "expired"] as const)(
      "keeps a resumed sandbox without terminal access when its terminal token is %s",
      async (credentialState) => {
        const ttydToken =
          credentialState === "expired"
            ? await mintJwt({ exp: Math.floor(Date.now() / 1000) - 1 }, "sandbox-auth-token")
            : null;
        const sandbox = createMockSandbox({
          status: "stopped",
          modal_object_id: "old-provider-obj",
          snapshot_image_id: null,
          ttyd_url: null,
          ttyd_token: ttydToken,
        });
        const storage = createMockStorage(
          createMockSession({ sandbox_settings: JSON.stringify({ terminalEnabled: true }) }),
          sandbox
        );
        const createSandbox = vi.fn(async (config: CreateSandboxConfig) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "replacement-provider-obj",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        }));
        const resumeSandbox = vi.fn(async () => ({
          success: true as const,
          providerObjectId: "old-provider-obj",
          lifetime: noLifetime(),
          ttydUrl: "https://terminal.test/resumed",
        }));
        const stopSandbox = vi.fn(async () => ({ success: true }));
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
          createSandbox,
          resumeSandbox,
          stopSandbox,
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

        // The stopped sandbox is the only copy of the workspace; losing the
        // terminal must not delete it.
        expect(resumeSandbox).toHaveBeenCalledOnce();
        expect(stopSandbox).not.toHaveBeenCalled();
        expect(createSandbox).not.toHaveBeenCalled();
        expect(sandbox.modal_object_id).toBe("old-provider-obj");
        expect(sandbox.status).toBe("connecting");
        expect(sandbox.ttyd_url).toBeNull();
        expect(sandbox.ttyd_token).toBeNull();
      }
    );

    it("keeps resuming a sandbox whose initial terminal preview could not be issued", async () => {
      const sandbox = createMockSandbox({
        status: "pending",
        created_at: Date.now() - 60_000,
        modal_object_id: null,
        ttyd_url: null,
        ttyd_token: null,
      });
      const storage = createMockStorage(
        createMockSession({ sandbox_settings: JSON.stringify({ terminalEnabled: true }) }),
        sandbox
      );
      const createSandbox = vi.fn(async (config: CreateSandboxConfig) => ({
        sandboxId: config.sandboxId,
        providerObjectId: "initial-provider-obj",
        createdAt: Date.now(),
        lifetime: noLifetime(),
      }));
      const resumeSandbox = vi.fn(async () => ({
        success: true as const,
        providerObjectId: "initial-provider-obj",
        lifetime: noLifetime(),
        ttydUrl: "https://terminal.test/resumed",
      }));
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        createSandbox,
        resumeSandbox,
        stopSandbox,
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
      expect(sandbox.ttyd_token).toBeNull();
      sandbox.status = "stopped";
      await manager.spawnSandbox();

      expect(resumeSandbox).toHaveBeenCalledOnce();
      expect(createSandbox).toHaveBeenCalledOnce();
      expect(stopSandbox).not.toHaveBeenCalled();
      expect(sandbox.modal_object_id).toBe("initial-provider-obj");
      expect(sandbox.ttyd_url).toBeNull();
    });

    it("resumes retained saved state without terminal access when its terminal token expired", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "retained-source",
        ttyd_url: null,
        ttyd_token: await mintJwt({ exp: Math.floor(Date.now() / 1000) - 1 }, "sandbox-auth-token"),
      });
      const storage = createMockStorage(
        createMockSession({ sandbox_settings: JSON.stringify({ terminalEnabled: true }) }),
        sandbox
      );
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true as const,
          providerObjectId: "retained-source",
          lifetime: noLifetime(),
          ttydUrl: "https://terminal.test/resumed",
        })),
      });
      const shutdown = createUnmanagedShutdown();
      shutdown.startupDecision.mockReturnValue({
        kind: "resume_retained",
        providerObjectId: "retained-source",
        runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
      });
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        createTestConfig()
      );

      await manager.spawnSandbox();

      // Retrying recovery cannot renew the credential, so holding here would
      // leave the saved workspace unrecoverable.
      expect(shutdown.holdFailedRecovery).not.toHaveBeenCalled();
      expect(shutdown.recordProviderStartup).toHaveBeenCalledOnce();
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(sandbox.modal_object_id).toBe("retained-source");
      expect(sandbox.ttyd_url).toBeNull();
    });

    it("does not carry a predecessor's runtime version onto a replacement's snapshot", async () => {
      // The row starts out describing a sandbox that reported a compatible
      // runtime. Once it is replaced, a snapshot the replacement takes must be
      // stamped unknown until the new sandbox reports for itself — otherwise a
      // downgraded or silent runtime inherits a clean bill of health.
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
      const broadcaster = createMockBroadcaster();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createCheckpointShutdown(provider, storage, broadcaster),
        createTestConfig()
      );

      expect(sandbox.runtime_version).toBe(COMPATIBLE_RUNTIME_VERSION);

      await manager.spawnSandbox();
      await manager.triggerSnapshot("execution_complete");

      expect(sandbox.runtime_version).toBeNull();
      expect(storage.calls).toContain("recordSandboxSnapshot:snapshot-img-123:null");
    });

    it("seeds the restored sandbox's runtime version from the snapshot", async () => {
      // OpenComputer and Vercel export the current SANDBOX_VERSION into every
      // sandbox they start, including ones forked from an old checkpoint, so
      // the snapshot's own version has to win.
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
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

      expect(provider.restoreFromSnapshot).toHaveBeenCalled();
      expect(storage.calls).toContain(`updateSandboxRuntimeVersion:${COMPATIBLE_RUNTIME_VERSION}`);
      expect(sandbox.runtime_version).toBe(COMPATIBLE_RUNTIME_VERSION);
    });

    it("holds instead of discarding a snapshot taken by a retired runtime", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: "v1-retired",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
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

      expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(sandbox.snapshot_image_id).toBe("img-abc123");
    });

    it("holds when the snapshot predates runtime-version recording", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
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

      expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(sandbox.snapshot_image_id).toBe("img-abc123");
    });

    it("resets isSpawningSandbox flag after restore throws error", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => {
          throw new SandboxProviderError("Network timeout", "transient");
        }),
      });

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      // Before spawn, should not be spawning
      expect(manager.isSpawning()).toBe(false);

      await manager.spawnSandbox();

      // After failed restore, isSpawning should be reset to false
      expect(manager.isSpawning()).toBe(false);
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    });

    it("resets isSpawningSandbox flag after restore returns failure", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(
          async (): Promise<RestoreResult> => ({
            success: false,
            error: "Snapshot not found",
          })
        ),
      });

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      // Before spawn, should not be spawning
      expect(manager.isSpawning()).toBe(false);

      await manager.spawnSandbox();

      // After failed restore (success=false), isSpawning should be reset to false
      expect(manager.isSpawning()).toBe(false);
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
      expect(
        broadcaster.messages.some(
          (m) => (m as { type: string; error?: string }).error === "Snapshot not found"
        )
      ).toBe(true);
    });

    it("updates status correctly through lifecycle", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
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

      // Should go: pending -> spawning -> connecting
      const statusCalls = storage.calls.filter((c) => c.startsWith("updateSandbox"));
      expect(statusCalls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("commitProviderStartup");
    });

    it("keeps earlier boot failures counted when the provider merely accepts a spawn", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "failed" as SandboxStatus,
        created_at: now - 60000,
        spawn_failure_count: 2,
        last_spawn_failure: now - 60000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
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

      expect(provider.createSandbox).toHaveBeenCalledOnce();
      // The provider accepting the request says nothing about whether this
      // boot will connect; only a connected bridge clears the streak.
      expect(sandbox.spawn_failure_count).toBe(2);
    });

    it("leaves the boot-failure streak in place when the bridge connects", async () => {
      // A connected bridge has not yet consumed anything: the pending prompt
      // is claimed only after a further await, and a fatal report in that
      // gap re-drives the same prompt. Clearing here would let a sandbox
      // that connects and dies before taking a prompt loop unbounded.
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        spawn_failure_count: 2,
        last_spawn_failure: now - 60000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      manager.onSandboxConnected();

      expect(sandbox.spawn_failure_count).toBe(2);
    });

    it("clears the boot-failure streak once a prompt is dispatched to the sandbox", async () => {
      // Dispatch is the first point where a failure costs something: from
      // here a fatal report fails the prompt the sandbox was running, so
      // every replacement after this consumes a queued prompt.
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready" as SandboxStatus,
        spawn_failure_count: 2,
        last_spawn_failure: now - 60000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      manager.onPromptDispatched();

      expect(sandbox.spawn_failure_count).toBe(0);
    });

    it("fails and counts an attempt whose reservation broke after persisting it", async () => {
      // Reservation persists `spawning` and then awaits the connect alarm.
      // If that await throws, no watchdog was armed and no provider call was
      // made, so nothing else will ever fail or count this attempt.
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      alarmScheduler.schedule = vi.fn(async () => {
        throw new Error("alarm storage unavailable");
      });
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(sandbox.spawn_failure_count).toBe(1);
      // Phase 1 already persisted `spawning` for this identity, and no
      // watchdog was armed to fail it later, so this catch must: a row left
      // in `spawning` would make the next prompt wait on an attempt that
      // has already ended.
      expect(sandbox.status).toBe("failed");
      expect(sandbox.last_spawn_error).toContain("alarm storage unavailable");
    });

    it("handles provider errors and increments failure count for permanent errors", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new SandboxProviderError("Auth failed", "permanent");
        }),
      });

      const manager = createTestLifecycleManager(
        provider,
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

      expect(storage.calls).toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    });

    it("does not increment circuit breaker for transient errors", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new SandboxProviderError("Network timeout", "transient");
        }),
      });

      const manager = createTestLifecycleManager(
        provider,
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

      expect(storage.calls).not.toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    });

    it("fails spawn when getUserEnvVars rejects", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      storage.getUserEnvVars = vi.fn(async () => {
        throw new Error("D1 decryption failure");
      });
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
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

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
      expect(manager.isSpawning()).toBe(false);
    });

    it("skips spawn when already spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
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

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  describe("onSandboxSocketAttached", () => {
    it("moves the attaching generation from spawning to connecting and says so", () => {
      const sandbox = createMockSandbox({ status: "spawning", created_at: 7000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      manager.onSandboxSocketAttached({ sandboxId: sandbox.modal_sandbox_id, createdAt: 7000 });

      expect(sandbox.status).toBe("connecting");
      expect(broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "connecting" });
    });

    it("moves an unfenced failed row to connecting: a watchdog-failed boot that finally connected", () => {
      // #1905 self-heal. The socket registry closes every sandbox socket of a
      // `failed` row, so the row must leave `failed` at attach or the bridge
      // it just admitted is cut off and its ready event spawns a duplicate.
      const sandbox = createMockSandbox({ status: "failed", fenced: 0, created_at: 7000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      manager.onSandboxSocketAttached({ sandboxId: sandbox.modal_sandbox_id, createdAt: 7000 });

      expect(sandbox.status).toBe("connecting");
      expect(broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "connecting" });
    });

    it("leaves a fenced failed row failed", () => {
      const sandbox = createMockSandbox({ status: "failed", fenced: 1, created_at: 7000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      manager.onSandboxSocketAttached({ sandboxId: sandbox.modal_sandbox_id, createdAt: 7000 });

      expect(sandbox.status).toBe("failed");
      expect(broadcaster.messages).toEqual([]);
    });

    it.each(["connecting", "ready"] as const)(
      "leaves a %s row as it is (the ready event, not attach, decides readiness)",
      (status) => {
        const sandbox = createMockSandbox({ status, created_at: 7000 });
        const storage = createMockStorage(createMockSession(), sandbox);
        const broadcaster = createMockBroadcaster();
        const manager = createTestLifecycleManager(
          createMockProvider(),
          storage,
          storage,
          broadcaster,
          createMockWebSocketManager(true),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createUnmanagedShutdown(),
          createTestConfig()
        );

        manager.onSandboxSocketAttached({ sandboxId: sandbox.modal_sandbox_id, createdAt: 7000 });

        expect(sandbox.status).toBe(status);
        expect(broadcaster.messages).toEqual([]);
      }
    );

    it("does not move a row a newer reservation owns", () => {
      const sandbox = createMockSandbox({ status: "spawning", created_at: 9000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      manager.onSandboxSocketAttached({ sandboxId: sandbox.modal_sandbox_id, createdAt: 7000 });

      expect(sandbox.status).toBe("spawning");
    });
  });

  describe("circuit breaker window as the idle gap between attempts", () => {
    // A re-drive chain has no idle time: each attempt starts the moment the
    // previous one failed. Measured failure-to-failure, boots longer than the
    // window would reset the streak every time and the chain would never end.
    it("opens after three automatic re-drives whose boots each outlast the window", async () => {
      vi.useFakeTimers();
      try {
        const bootMs = DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.windowMs + 60_000;
        const sandbox = createMockSandbox({ status: "connecting", spawn_failure_count: 0 });
        const storage = createMockStorage(createMockSession(), sandbox);
        const provider = createMockProvider();
        const manager = createTestLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(true),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createUnmanagedShutdown(),
          createTestConfig()
        );

        for (let attempt = 0; attempt < 3; attempt++) {
          // The attempt started when the previous failure re-drove the queue.
          sandbox.status = "connecting";
          sandbox.created_at = Date.now();
          vi.advanceTimersByTime(bootMs);
          expect(await manager.terminateFailedSandbox("start.sh exited 1")).toBe(true);
        }
        expect(sandbox.spawn_failure_count).toBe(3);

        await manager.spawnSandbox();

        expect(provider.createSandbox).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts a fresh streak when the next attempt began after an idle gap of a full window", async () => {
      vi.useFakeTimers();
      try {
        const sandbox = createMockSandbox({
          status: "connecting",
          spawn_failure_count: 2,
          last_spawn_failure: Date.now(),
        });
        const storage = createMockStorage(createMockSession(), sandbox);
        const manager = createTestLifecycleManager(
          createMockProvider(),
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(true),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createUnmanagedShutdown(),
          createTestConfig()
        );
        // The user came back after the window and this attempt began then.
        vi.advanceTimersByTime(DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.windowMs);
        sandbox.created_at = Date.now();
        vi.advanceTimersByTime(6 * 60_000);

        await manager.terminateFailedSandbox("start.sh exited 1");

        expect(sandbox.spawn_failure_count).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("triggerSnapshot", () => {
    it("takes snapshot when provider supports it", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

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

      await manager.triggerSnapshot("test_reason");

      expect(provider.takeSnapshot).toHaveBeenCalled();
      expect(storage.calls).toContain(
        `recordSandboxSnapshot:snapshot-img-123:${COMPATIBLE_RUNTIME_VERSION}`
      );
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "snapshot_saved")
      ).toBe(true);
      expect(broadcaster.messages.slice(-2)).toEqual([
        { type: "sandbox_status", status: "ready" },
        { type: "sandbox_access_changed" },
      ]);
    });

    it("skips when provider does not support snapshots", async () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider: SandboxProvider = {
        name: "no-snapshot",
        capabilities: {
          supportsSandboxTimeout: true,
          supportsSnapshots: false,
          supportsRestore: false,
        },
        createSandbox: vi.fn(),
        // No takeSnapshot method
      };

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

      await manager.triggerSnapshot("test_reason");

      // Should not crash, just skip
      expect(storage.calls).not.toContain("recordSandboxSnapshot");
    });

    it("stores returned imageId", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        takeSnapshot: vi.fn(async () => ({
          success: true,
          imageId: "custom-snapshot-id",
        })),
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

      expect(storage.calls).toContain(
        `recordSandboxSnapshot:custom-snapshot-id:${COMPATIBLE_RUNTIME_VERSION}`
      );
    });

    it("leaves a status written during the snapshot in place", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        takeSnapshot: vi.fn(async () => {
          // The heartbeat-stale alarm (or a cancel) lands while the provider
          // call is in flight: status written, access cleared, socket detached.
          sandbox.status = "stale";
          return { success: true, imageId: "snapshot-img-123" };
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

      expect(sandbox.status).toBe("stale");
      expect(storage.calls).toContain("transitionSandboxStatus:snapshotting->ready");
      expect(broadcaster.messages).not.toContainEqual({ type: "sandbox_status", status: "ready" });
      expect(broadcaster.messages).not.toContainEqual({ type: "sandbox_access_changed" });
      // The image itself is still recorded: it describes the filesystem, not the row.
      expect(sandbox.snapshot_image_id).toBe("snapshot-img-123");
    });

    it("drops a snapshot of a sandbox that was replaced during the provider call", async () => {
      const sandbox = createMockSandbox({ status: "ready", modal_sandbox_id: "sb-old" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        takeSnapshot: vi.fn(async () => {
          // Terminated and re-reserved while the snapshot was in flight.
          sandbox.status = "spawning";
          sandbox.modal_sandbox_id = "sb-new";
          return { success: true, imageId: "snapshot-of-old" };
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

      expect(sandbox.snapshot_image_id).toBeNull();
      expect(sandbox.status).toBe("spawning");
      expect(broadcaster.messages.map((m) => (m as { type: string }).type)).not.toContain(
        "snapshot_saved"
      );
    });

    it("handles snapshot errors gracefully", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        takeSnapshot: vi.fn(async () => ({
          success: false,
          error: "Snapshot failed",
        })),
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

      // Should not throw
      await manager.triggerSnapshot("test");

      expect(storage.calls).not.toContain("recordSandboxSnapshot");
    });

    it("does not claim a failed unmanaged destructive snapshot", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        capabilities: { snapshotRequiresShutdown: true },
        takeSnapshot: vi.fn(async () => ({ success: false, error: "capture failed" })),
      });
      const shutdown = createCheckpointShutdown(provider, storage, broadcaster);
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        createTestConfig()
      );

      await manager.triggerSnapshot("test");

      expect(provider.takeSnapshot).toHaveBeenCalledOnce();
      expect(storage.calls).not.toContain("recordSandboxSnapshot");
      expect(broadcaster.messages).not.toContainEqual(
        expect.objectContaining({ type: "snapshot_saved" })
      );
    });

    it("delegates checkpoint capture and publishes the saved outcome", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      vi.spyOn(broadcaster, "broadcast").mockImplementation((message) => {
        if ((message as { type: string }).type === "snapshot_saved") throw new Error("broadcast");
      });
      const takeSnapshot = vi.fn(async () => ({ success: true, imageId: "snapshot" }));
      const provider = createMockProvider({ takeSnapshot });
      const shutdown = {
        ...createUnmanagedShutdown(),
        captureCheckpoint: vi.fn(async () => ({
          outcome: "saved" as const,
          imageId: "snapshot",
          sourceStopped: false,
        })),
      } satisfies SandboxShutdownLifecycle;
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        createTestConfig()
      );

      await manager.triggerSnapshot("test");

      expect(shutdown.captureCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: sandbox.modal_sandbox_id }),
        "test"
      );
    });
  });

  describe("terminateUnresponsiveSandbox", () => {
    it.each(["fatal", "unresponsive"] as const)(
      "does not apply %s failed-boot cleanup after the generation changes",
      async (trigger) => {
        const sandbox = createMockSandbox({ status: "connecting" });
        const storage = {
          ...createMockStorage(createMockSession(), sandbox),
          getSandbox: () => ({ ...sandbox }),
        };
        const shutdown = createUnmanagedShutdown();
        shutdown.requestShutdown.mockImplementation(async () => {
          sandbox.status = "ready";
          return "unmanaged";
        });
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox: vi.fn(async () => ({ success: true })),
        });
        const manager = createTestLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(true),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          shutdown,
          createTestConfig()
        );
        if (trigger === "fatal") await manager.terminateFailedSandbox("boot failed");
        else await manager.terminateUnresponsiveSandbox("stop_send_failed");
        expect(provider.stopSandbox).not.toHaveBeenCalled();
        expect(sandbox.status).toBe("ready");
      }
    );

    it.each([
      ["prompt_dispatch_send_failed", "Prompt dispatch send failed"],
      ["stop_send_failed", "Stop command send failed"],
      ["stop_confirmation_timeout", "Stop confirmation timed out"],
    ] as const)(
      "uses the %s reason for failed-boot provider stop and socket close",
      async (trigger, closeReason) => {
        const storage = createMockStorage(
          createMockSession(),
          createMockSandbox({ status: "connecting" })
        );
        const wsManager = createMockWebSocketManager(true);
        const stopSandbox = vi.fn(async () => ({ success: true }));
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox,
        });
        const manager = createTestLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          wsManager,
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createCheckpointShutdown(provider, storage, createMockBroadcaster()),
          createTestConfig()
        );

        await manager.terminateUnresponsiveSandbox(trigger);

        expect(stopSandbox).toHaveBeenCalledWith(
          expect.objectContaining({ reason: trigger, intent: "destroy" })
        );
        expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(1011, closeReason);
      }
    );

    it("detaches dispatch before awaiting a paused provider stop", async () => {
      let resolveStop!: (result: StopResult) => void;
      const providerStop = new Promise<StopResult>((resolve) => {
        resolveStop = resolve;
      });
      const wsManager = createMockWebSocketManager(true);
      const mockStorage = createMockStorage(
        createMockSession(),
        createMockSandbox({ status: "connecting" })
      );
      const manager = createTestLifecycleManager(
        createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox: vi.fn(() => providerStop),
        }),
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );
      const terminating = manager.terminateUnresponsiveSandbox("stop_confirmation_timeout");
      let completed = false;
      void terminating.then(() => {
        completed = true;
      });

      await vi.waitFor(() =>
        expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(
          1011,
          "Stop confirmation timed out"
        )
      );
      expect(completed).toBe(false);
      resolveStop({ success: true });
      await terminating;
      expect(completed).toBe(true);
    });
  });

  describe("terminateFailedSandbox", () => {
    it("detaches dispatch and gates replacement spawn until provider termination completes", async () => {
      let resolveStop!: (result: StopResult) => void;
      const stopSandbox = vi.fn(
        () =>
          new Promise<StopResult>((resolve) => {
            resolveStop = resolve;
          })
      );
      const createSandbox = vi.fn();
      const storage = createMockStorage();
      const wsManager = createMockWebSocketManager(true);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        stopSandbox,
        createSandbox,
      });
      const access = new SandboxAccess({
        storage,
        broadcaster,
        sockets: wsManager,
        canResumeAfterStop: () => false,
        getLogger: () => createLogger("lifecycle-manager"),
      });
      const shutdown = createCheckpointShutdown(provider, storage, broadcaster, undefined, () =>
        access.retireShutdownAccess()
      );
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        access,
        createTestConfig()
      );

      const termination = manager.terminateFailedSandbox("OpenCode repeatedly crashed");

      expect(storage.calls).toContain("updateSandboxStatus:stale");
      expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(
        1000,
        "Sandbox state preserved"
      );
      expect(manager.isSpawning()).toBe(true);
      await vi.waitFor(() =>
        expect(stopSandbox).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "fatal_runtime_error", intent: "destroy" })
        )
      );
      await manager.spawnSandbox();
      expect(createSandbox).not.toHaveBeenCalled();

      resolveStop({ success: true });
      await expect(termination).resolves.toBe(true);
      expect(manager.isSpawning()).toBe(false);
    });

    it("counts a fatal runtime termination toward the circuit breaker", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({ status: "ready" as SandboxStatus });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await expect(manager.terminateFailedSandbox("OpenCode repeatedly crashed")).resolves.toBe(
        true
      );

      expect(sandbox.spawn_failure_count).toBe(1);
      expect(sandbox.last_spawn_failure).toBeGreaterThanOrEqual(now);
    });

    it("opens the circuit breaker after repeated fatal boots so the re-drive stops spawning", async () => {
      // A boot that reports fatal before its bridge connects (setup.sh exits
      // non-zero, the harness never comes up) re-drives the pending prompt
      // onto a fresh sandbox that dies the same way. Nothing connects, so
      // nothing clears the streak, and the breaker has to end it.
      const sandbox = createMockSandbox({ status: "failed" as SandboxStatus });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();
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

      for (
        let attempt = 0;
        attempt < DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.threshold;
        attempt++
      ) {
        await manager.spawnSandbox();
        expect(sandbox.status).toBe("connecting");
        await expect(manager.terminateFailedSandbox("setup.sh exited 1")).resolves.toBe(true);
      }
      const spawnsBeforeOpen = vi.mocked(provider.createSandbox).mock.calls.length;

      await manager.spawnSandbox();

      expect(vi.mocked(provider.createSandbox).mock.calls.length).toBe(spawnsBeforeOpen);
      expect(sandbox.last_spawn_error).toContain("temporarily disabled");
    });

    it("opens the circuit breaker when replacements connect but die before readiness", async () => {
      // The bridge connecting consumes nothing: the pending prompt is
      // claimed only after a further await, and a fatal report in that gap
      // re-drives the same prompt. So connect must not clear the streak, or
      // this sequence would replace the sandbox forever.
      const sandbox = createMockSandbox({ status: "failed" as SandboxStatus });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      for (
        let attempt = 0;
        attempt < DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.threshold;
        attempt++
      ) {
        await manager.spawnSandbox();
        // The production connection path calls this before publishing ready.
        manager.onSandboxConnected();
        sandbox.status = "connecting";
        await expect(manager.terminateFailedSandbox("OpenCode crashed")).resolves.toBe(true);
      }
      const spawnsBeforeOpen = vi.mocked(provider.createSandbox).mock.calls.length;

      await manager.spawnSandbox();

      expect(vi.mocked(provider.createSandbox).mock.calls.length).toBe(spawnsBeforeOpen);
      expect(sandbox.last_spawn_error).toContain("temporarily disabled");
    });

    it("requires recovery after a serving sandbox fails even when dispatch reset the breaker", async () => {
      const sandbox = createMockSandbox({ status: "failed" as SandboxStatus });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createCheckpointShutdown(provider, storage, createMockBroadcaster()),
        createTestConfig()
      );

      await manager.spawnSandbox();
      manager.onSandboxConnected();
      sandbox.status = "ready";
      manager.onPromptDispatched();
      await expect(manager.terminateFailedSandbox("OpenCode crashed")).resolves.toBe(true);
      expect(sandbox.spawn_failure_count).toBe(1);
      const spawnsBeforeLast = vi.mocked(provider.createSandbox).mock.calls.length;

      await manager.spawnSandbox();

      expect(vi.mocked(provider.createSandbox).mock.calls.length).toBe(spawnsBeforeLast);
      expect(manager.mayProcessQueuedWork()).toBe(false);
    });

    it.each(["stopped", "stale", "failed"] as const)(
      "does not overwrite or detach a %s sandbox",
      async (status) => {
        const storage = createMockStorage(createMockSession(), createMockSandbox({ status }));
        const wsManager = createMockWebSocketManager(true);
        const manager = createTestLifecycleManager(
          createMockProvider(),
          storage,
          storage,
          createMockBroadcaster(),
          wsManager,
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createUnmanagedShutdown(),
          createTestConfig()
        );

        await expect(manager.terminateFailedSandbox("Delayed failure")).resolves.toBe(false);

        expect(storage.calls).not.toContain("updateSandboxStatus:failed");
        expect(wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      }
    );

    it("reports nothing to terminate for a boot the connect watchdog already failed", async () => {
      // A provider without explicit stop cannot kill the boot the watchdog
      // gave up on, so it runs on and eventually reports a fatal error of its
      // own. That report must not read as a fresh termination, or the caller
      // re-drives the pending prompt onto yet another sandbox.
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + 10_000),
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const wsManager = createMockWebSocketManager();
      const manager = createTestLifecycleManager(
        createMockProvider({ capabilities: { supportsExplicitStop: false } }),
        storage,
        storage,
        createMockBroadcaster(),
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await expect(manager.handleAlarm()).resolves.toBe("sandbox_failed");
      expect(sandbox.status).toBe("failed");

      await expect(
        manager.terminateFailedSandbox("failed to fetch managed skills: 401 Unauthorized")
      ).resolves.toBe(false);

      expect(storage.calls.filter((c) => c === "updateSandboxStatus:failed")).toHaveLength(1);
      expect(storage.calls).not.toContain(
        "setLastSpawnError:failed to fetch managed skills: 401 Unauthorized"
      );
      expect(wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    });
  });

  describe("scheduleDisconnectCheck", () => {
    it("schedules alarm at heartbeat timeout from now", async () => {
      const storage = createMockStorage();
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      const before = Date.now();
      await manager.scheduleDisconnectCheck();
      const after = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const alarmTime = alarmScheduler.alarms[0];
      // Should be approximately now + heartbeat.timeoutMs (90s)
      expect(alarmTime).toBeGreaterThanOrEqual(before + config.heartbeat.timeoutMs);
      expect(alarmTime).toBeLessThanOrEqual(after + config.heartbeat.timeoutMs);
    });
  });

  describe("warmSandbox", () => {
    it("skips when sandbox already connected", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(true); // Has WebSocket
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("skips when status is spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("calls spawnSandbox when conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_warming")
      ).toBe(true);
      expect(provider.createSandbox).toHaveBeenCalled();
    });
  });

  describe("updateLastActivity", () => {
    it("updates storage", () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);

      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      const timestamp = Date.now();
      manager.updateLastActivity(timestamp);

      expect(storage.calls).toContain("updateSandboxLastActivity");
    });
  });

  describe("scheduleInactivityCheck", () => {
    it("schedules alarm at correct time", async () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = createTestLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );

      const beforeTime = Date.now();
      await manager.scheduleInactivityCheck();
      const afterTime = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const scheduledTime = alarmScheduler.alarms[0];
      expect(scheduledTime).toBeGreaterThanOrEqual(beforeTime + config.inactivity.timeoutMs);
      expect(scheduledTime).toBeLessThanOrEqual(afterTime + config.inactivity.timeoutMs);
    });
  });

  describe("repo-scope image lookup in doSpawn", () => {
    const REPO_MEMBER: SessionRepositoryInfo[] = [
      { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
    ];

    async function repoImageRow(
      overrides: Partial<ImageBuildSpawnRow> = {}
    ): Promise<ImageBuildSpawnRow> {
      return {
        id: "imgb-repo-1",
        provider_image_id: "img-abc123",
        repositories_fingerprint: await computeRepositoriesFingerprint(REPO_MEMBER),
        repository_shas: JSON.stringify([
          { repoOwner: "testowner", repoName: "testrepo", baseSha: "sha-def456" },
        ]),
        runtime_version: COMPATIBLE_RUNTIME_VERSION,
        ...overrides,
      };
    }

    function createRepoSessionManager(overrides?: {
      provider?: SandboxProvider;
      imageBuildLookup?: ImageBuildLookup;
      session?: SessionRow;
      sessionRepositories?: SessionRepositoryInfo[];
    }) {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(
        overrides?.session ?? createMockSession(),
        sandbox,
        undefined,
        overrides?.sessionRepositories ?? REPO_MEMBER
      );
      const provider = overrides?.provider ?? createMockProvider();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig(),
        overrides?.imageBuildLookup
      );
      return { manager, provider, storage };
    }

    it("boots from the repo image when the one-element fingerprint matches", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createRepoSessionManager({ imageBuildLookup });

      await manager.spawnSandbox();

      expect(imageBuildLookup.getLatestReady).toHaveBeenCalledWith({
        kind: "repo",
        id: "testowner/testrepo",
      });
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          prebuiltImageId: "img-abc123",
          prebuiltImageSha: "sha-def456",
        })
      );
    });

    it("boots a VNC-enabled session from a spawn-compatible v56 repo image", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createRepoSessionManager({
        imageBuildLookup,
        session: createMockSession({ vnc_enabled: 1 }),
      });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          prebuiltImageId: "img-abc123",
          prebuiltImageSha: "sha-def456",
          vncEnabled: true,
        })
      );
    });

    it("misses to base on a non-default-branch session (fingerprint reproduces the branch filter)", async () => {
      // The image was built on the default branch; a session on any other
      // branch computes a different one-element fingerprint and must not
      // boot from it.
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createRepoSessionManager({
        imageBuildLookup,
        session: createMockSession({ base_branch: "feature/xyz" }),
        sessionRepositories: [
          { repoOwner: "testowner", repoName: "testrepo", baseBranch: "feature/xyz" },
        ],
      });

      await manager.spawnSandbox();

      expect(imageBuildLookup.getLatestReady).toHaveBeenCalledWith({
        kind: "repo",
        id: "testowner/testrepo",
      });
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("rejects a repo image below the runtime floor at selection", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () =>
          repoImageRow({
            runtime_version: `v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION - 1}-before-preservation`,
          })
        ),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createRepoSessionManager({ imageBuildLookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("passes null prebuiltImageId when no ready image exists", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => null),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createRepoSessionManager({ imageBuildLookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("falls back gracefully when the image lookup fails", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createRepoSessionManager({ imageBuildLookup });

      await manager.spawnSandbox();

      // Should still spawn, just without a prebuilt image
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("passes null prebuiltImageId when no lookup is configured", async () => {
      const { manager, provider } = createRepoSessionManager();

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("marks the repo image restore-failed and retries from base when its artifact is unavailable", async () => {
      // Deliberate behavior change: the old repo path failed the spawn
      // outright; repo images now take the same restore fallback the
      // environment side has.
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValueOnce(new PrebuiltImageUnavailableError("image expired"))
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        }));
      const { manager, storage } = createRepoSessionManager({
        imageBuildLookup,
        provider: createMockProvider({ createSandbox }),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      expect(imageBuildLookup.markRestoreFailed).toHaveBeenCalledWith(
        "imgb-repo-1",
        expect.stringContaining("image expired")
      );
      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(createSandbox.mock.calls[1][0]).toEqual(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
      // The retry rotates the spawn identity, same as the environment path.
      const [firstAttempt, retryAttempt] = createSandbox.mock.calls.map(([config]) => config);
      expect(retryAttempt.sandboxAuthToken).not.toBe(firstAttempt.sandboxAuthToken);
      expect(retryAttempt.sandboxId).not.toBe(firstAttempt.sandboxId);
      expect(storage.calls).toContain("commitProviderStartup");
      expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
      expect(parseStructuredLogs(warnSpy)).toContainEqual(
        expect.objectContaining({
          event: "image_build.restore_failed",
          error_type: "permanent",
        })
      );
      warnSpy.mockRestore();
    });

    it("does not fail the image or retry from base on a transient provider error", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi.fn(async () => {
        throw new SandboxProviderError("request timed out", "transient");
      });
      const { manager, storage } = createRepoSessionManager({
        imageBuildLookup,
        provider: createMockProvider({ createSandbox }),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      expect(createSandbox).toHaveBeenCalledOnce();
      expect(imageBuildLookup.markRestoreFailed).not.toHaveBeenCalled();
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
      expect(parseStructuredLogs(warnSpy)).toContainEqual(
        expect.objectContaining({
          event: "image_build.spawn_error_transient",
          image_build_id: "imgb-repo-1",
          error_type: "transient",
          error: "request timed out",
        })
      );
      warnSpy.mockRestore();
    });

    it("does not fail the image or retry from base on an unrelated permanent provider error", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi.fn(async () => {
        throw new SandboxProviderError("quota exceeded", "permanent");
      });
      const { manager, storage } = createRepoSessionManager({
        imageBuildLookup,
        provider: createMockProvider({ createSandbox }),
      });

      await manager.spawnSandbox();

      expect(createSandbox).toHaveBeenCalledOnce();
      expect(imageBuildLookup.markRestoreFailed).not.toHaveBeenCalled();
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    });

    it("does not retire an image the provider is still waking", async () => {
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi.fn(async () => {
        throw new PrebuiltImageActivationPendingError("prebuilt snapshot is still inactive");
      });
      const { manager, storage } = createRepoSessionManager({
        imageBuildLookup,
        provider: createMockProvider({ createSandbox }),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      // Cold storage is not a broken image: retiring it here would cost a
      // rebuild for an image the next spawn can use.
      expect(createSandbox).toHaveBeenCalledOnce();
      expect(imageBuildLookup.markRestoreFailed).not.toHaveBeenCalled();
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
      expect(parseStructuredLogs(warnSpy)).toContainEqual(
        expect.objectContaining({
          event: "image_build.spawn_error_transient",
          image_build_id: "imgb-repo-1",
          error_type: "transient",
          error: "prebuilt snapshot is still inactive",
        })
      );
      warnSpy.mockRestore();
    });
  });

  describe("environment image lookup in doSpawn", () => {
    const ENV_MEMBERS: SessionRepositoryInfo[] = [
      { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
      { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
    ];

    async function envImageRow(
      overrides: Partial<ImageBuildSpawnRow> = {}
    ): Promise<ImageBuildSpawnRow> {
      return {
        id: "imgb-1",
        provider_image_id: "im-env-123",
        repositories_fingerprint: await computeRepositoriesFingerprint(ENV_MEMBERS),
        repository_shas: JSON.stringify([
          { repoOwner: "testowner", repoName: "testrepo", baseSha: "sha-primary" },
          { repoOwner: "testowner", repoName: "backend", baseSha: "sha-backend" },
        ]),
        runtime_version: COMPATIBLE_RUNTIME_VERSION,
        ...overrides,
      };
    }

    function createEnvironmentSessionManager(overrides?: {
      provider?: SandboxProvider;
      environmentImageLookup?: ImageBuildLookup;
      sessionRepositories?: SessionRepositoryInfo[];
      alarmScheduler?: AlarmScheduler;
    }) {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(
        createMockSession({ environment_id: "env-1" }),
        sandbox,
        undefined,
        overrides?.sessionRepositories ?? ENV_MEMBERS
      );
      const provider = overrides?.provider ?? createMockProvider();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        overrides?.alarmScheduler ?? createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig(),
        overrides?.environmentImageLookup
      );
      return { manager, provider, storage };
    }

    it("boots from the environment image when it matches the session's snapshot", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => envImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createEnvironmentSessionManager({ environmentImageLookup });

      await manager.spawnSandbox();

      expect(environmentImageLookup.getLatestReady).toHaveBeenCalledWith({
        kind: "environment",
        id: "env-1",
      });
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          prebuiltImageId: "im-env-123",
          prebuiltImageSha: "sha-primary",
          repositories: ENV_MEMBERS,
        })
      );
    });

    it("boots from base when the image does not match the session's own snapshot", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () =>
          envImageRow({
            repositories_fingerprint: await computeRepositoriesFingerprint([
              ...ENV_MEMBERS,
              { repoOwner: "testowner", repoName: "docs", baseBranch: "main" },
            ]),
          })
        ),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createEnvironmentSessionManager({ environmentImageLookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("never consults the repo scope for environment sessions", async () => {
      // Even a single-repo environment session must not fall back to that
      // repository's repo image: it bakes the repo's setup and secrets, not
      // the environment's.
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => null),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createEnvironmentSessionManager({
        environmentImageLookup,
        sessionRepositories: [ENV_MEMBERS[0]],
      });

      await manager.spawnSandbox();

      expect(environmentImageLookup.getLatestReady).toHaveBeenCalledTimes(1);
      expect(environmentImageLookup.getLatestReady).toHaveBeenCalledWith({
        kind: "environment",
        id: "env-1",
      });
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("falls back to base when the environment image lookup fails", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider, storage } = createEnvironmentSessionManager({
        environmentImageLookup,
      });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
      expect(storage.calls).toContain("commitProviderStartup");
    });

    it("boots from base when no environment image lookup is bound", async () => {
      const { manager, provider } = createEnvironmentSessionManager();

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("marks the image restore-failed and retries from base when its artifact is unavailable", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => envImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValueOnce(new PrebuiltImageUnavailableError("image expired"))
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        }));
      const alarmScheduler = createMockAlarmScheduler();
      const { manager, storage } = createEnvironmentSessionManager({
        environmentImageLookup,
        provider: createMockProvider({ createSandbox }),
        alarmScheduler,
      });

      await manager.spawnSandbox();

      expect(environmentImageLookup.markRestoreFailed).toHaveBeenCalledWith(
        "imgb-1",
        expect.stringContaining("image expired")
      );
      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(createSandbox.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          prebuiltImageId: null,
          prebuiltImageSha: null,
          repositories: ENV_MEMBERS,
        })
      );
      // The retry rotates the spawn identity: the failed attempt may have
      // created an orphan sandbox provider-side, and it must not share
      // credentials with the sandbox that actually boots.
      const [firstAttempt, retryAttempt] = createSandbox.mock.calls.map(([config]) => config);
      expect(retryAttempt.sandboxAuthToken).not.toBe(firstAttempt.sandboxAuthToken);
      expect(retryAttempt.sandboxId).not.toBe(firstAttempt.sandboxId);
      expect(vi.mocked(storage.updateSandboxForSpawn)).toHaveBeenCalledTimes(2);
      expect(alarmScheduler.alarms).toEqual(
        vi
          .mocked(storage.updateSandboxForSpawn)
          .mock.calls.map(
            ([data]) => data.createdAt + DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs
          )
      );
      expect(storage.calls).toContain("commitProviderStartup");
      expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
    });

    it("fails the spawn when the base-image retry also fails", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => envImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValueOnce(new PrebuiltImageUnavailableError("image expired"))
        .mockRejectedValueOnce(new SandboxProviderError("quota exceeded", "permanent"));
      const { manager, storage } = createEnvironmentSessionManager({
        environmentImageLookup,
        provider: createMockProvider({ createSandbox }),
      });

      await manager.spawnSandbox();

      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(environmentImageLookup.markRestoreFailed).toHaveBeenCalledTimes(1);
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    });

    it("still retries from base when marking the row restore-failed fails", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => envImageRow()),
        markRestoreFailed: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValueOnce(new PrebuiltImageUnavailableError("image expired"))
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        }));
      const { manager, storage } = createEnvironmentSessionManager({
        environmentImageLookup,
        provider: createMockProvider({ createSandbox }),
      });

      await manager.spawnSandbox();

      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(storage.calls).toContain("commitProviderStartup");
    });
  });

  describe("multi-repo spawn", () => {
    const MULTI_REPO_MEMBERS: SessionRepositoryInfo[] = [
      { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
      { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
    ];

    function createMultiRepoManager(overrides?: {
      provider?: SandboxProvider;
      imageBuildLookup?: ImageBuildLookup;
      mcpServerLookup?: McpServerLookup;
      sandbox?: ReturnType<typeof createMockSandbox>;
      sessionRepositories?: SessionRepositoryInfo[];
    }) {
      const sandbox =
        overrides?.sandbox ??
        createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(
        createMockSession(),
        sandbox,
        undefined,
        overrides?.sessionRepositories ?? MULTI_REPO_MEMBERS
      );
      const provider = overrides?.provider ?? createMockProvider();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        { ...createTestConfig(), mcpServerLookup: overrides?.mcpServerLookup },
        overrides?.imageBuildLookup
      );
      return { manager, provider, storage };
    }

    it("passes the member list on fresh spawns", async () => {
      const { manager, provider } = createMultiRepoManager();

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ repositories: MULTI_REPO_MEMBERS })
      );
    });

    it("omits the member list for single-member sessions", async () => {
      const { manager, provider } = createMultiRepoManager({
        sessionRepositories: [MULTI_REPO_MEMBERS[0]],
      });

      await manager.spawnSandbox();

      const config = vi.mocked(provider.createSandbox).mock.calls[0][0];
      expect(config.repositories).toBeUndefined();
    });

    it("omits the member list for pre-list sessions with no member rows", async () => {
      const { manager, provider } = createMultiRepoManager({ sessionRepositories: [] });

      await manager.spawnSandbox();

      const config = vi.mocked(provider.createSandbox).mock.calls[0][0];
      expect(config.repositories).toBeUndefined();
    });

    it("never uses prebuilt images for multi-repo ad-hoc sessions", async () => {
      // A repo image bakes a single checkout; only environment sessions
      // (matched by their environment scope) can boot a multi-repo workspace
      // from a prebuilt image.
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => null),
        markRestoreFailed: vi.fn(async () => true),
      };
      const { manager, provider } = createMultiRepoManager({ imageBuildLookup });

      await manager.spawnSandbox();

      expect(imageBuildLookup.getLatestReady).not.toHaveBeenCalled();
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("passes every member to the MCP server lookup", async () => {
      const mcpServerLookup: McpServerLookup = {
        getDecryptedForSession: vi.fn(async () => []),
      };
      const { manager } = createMultiRepoManager({ mcpServerLookup });

      await manager.spawnSandbox();

      expect(mcpServerLookup.getDecryptedForSession).toHaveBeenCalledWith([
        { repoOwner: "testowner", repoName: "testrepo" },
        { repoOwner: "testowner", repoName: "backend" },
      ]);
    });

    it("passes storage-synthesized members to the MCP lookup on pre-list sessions", async () => {
      // Pre-list sessions get their scalar member synthesized by the storage
      // adapter (buildSessionRepositories owns the rule) — the manager passes
      // the list through as-is.
      const mcpServerLookup: McpServerLookup = {
        getDecryptedForSession: vi.fn(async () => []),
      };
      const { manager } = createMultiRepoManager({
        mcpServerLookup,
        sessionRepositories: [{ repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" }],
      });

      await manager.spawnSandbox();

      expect(mcpServerLookup.getDecryptedForSession).toHaveBeenCalledWith([
        { repoOwner: "testowner", repoName: "testrepo" },
      ]);
    });

    it("passes the member list on snapshot restores", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "snapshot-img-1",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
        created_at: Date.now() - 60000,
      });
      const { manager, provider } = createMultiRepoManager({ sandbox });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ repositories: MULTI_REPO_MEMBERS })
      );
    });
  });

  describe("sandbox settings", () => {
    it("uses the configured sandbox timeout for fresh spawns", async () => {
      const session = createMockSession({
        sandbox_settings: '{"sandboxTimeoutMs":14400000}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = createMockProvider();
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: 14_400 })
      );
    });

    it("uses the configured sandbox timeout for snapshot restores", async () => {
      const session = createMockSession({
        sandbox_settings: '{"sandboxTimeoutMs":14400000}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const provider = createMockProvider();
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: 14_400 })
      );
    });

    it("uses the configured sandbox timeout when resuming in place", async () => {
      const session = createMockSession({
        sandbox_settings: '{"sandboxTimeoutMs":14400000}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "provider-obj",
        snapshot_image_id: null,
      });
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({ success: true as const, lifetime: noLifetime() })),
      });
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: 14_400 })
      );
    });

    it("uses the configured sandbox timeout for child sessions", async () => {
      const session = createMockSession({
        spawn_source: "agent",
        sandbox_settings: '{"sandboxTimeoutMs":14400000}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = createMockProvider();
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: 14_400 })
      );
    });

    it("uses the provider default for child sessions when no timeout is configured", async () => {
      const session = createMockSession({ spawn_source: "agent", sandbox_settings: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = createMockProvider();
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: undefined })
      );
    });

    it("rejects configured timeouts when the provider cannot enforce them", async () => {
      const session = createMockSession({
        spawn_source: "agent",
        sandbox_settings: '{"sandboxTimeoutMs":14400000}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = createMockProvider({
        capabilities: { supportsSandboxTimeout: false },
      });
      const broadcaster = createMockBroadcaster();
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(broadcaster.messages).toContainEqual({
        type: "sandbox_error",
        error: "mock does not support configurable sandbox timeouts",
      });
    });

    it("ignores legacy resource and timeout settings for Daytona", async () => {
      const session = createMockSession({
        spawn_source: "agent",
        sandbox_settings:
          '{"cpuCores":2,"memoryMib":4096,"sandboxTimeoutMs":14400000,"terminalEnabled":true}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = {
        ...createMockProvider({ capabilities: { supportsSandboxTimeout: false } }),
        name: "daytona",
      };
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutSeconds: undefined,
          sandboxSettings: { terminalEnabled: true },
        })
      );
    });

    it("uses the provider default for child sessions on unsupported providers", async () => {
      const session = createMockSession({ spawn_source: "agent", sandbox_settings: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = createMockProvider({
        capabilities: { supportsSandboxTimeout: false },
      });
      const mockStorage = createMockStorage(session, sandbox);
      const manager = createTestLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: undefined })
      );
    });

    it("doSpawn() passes sandboxSettings from session to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("doSpawn() passes empty settings when sandbox_settings is null", async () => {
      const session = createMockSession({ sandbox_settings: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("doSpawn() sanitizes malformed tunnelPorts from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":["not-a-number", -1, 99999, 3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("doSpawn() forwards valid cpuCores and memoryMib to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"cpuCores":2,"memoryMib":4096}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { cpuCores: 2, memoryMib: 4096 },
        })
      );
    });

    it("doSpawn() drops non-positive cpuCores and memoryMib from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: '{"cpuCores":-2,"memoryMib":0}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("doSpawn() broadcasts tunnel_urls when provider returns them", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        createSandbox: vi.fn(async (config: CreateSandboxConfig) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          lifetime: noLifetime(),
          tunnelUrls: { "3000": "https://tunnel.example.com" },
        })),
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

      expect(storage.calls).toContain("updateSandboxTunnelUrls");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_access_changed")
      ).toBe(true);
    });

    it("restoreFromSnapshot() passes sandboxSettings from session to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it.each(["openai/gpt-5.3-codex", "openai/gpt-5.3-codex-spark"])(
      "restores a session with retired %s on the OpenAI replacement",
      async (model) => {
        const session = createMockSession({ model });
        const sandbox = createMockSandbox({
          status: "stopped",
          snapshot_image_id: "img-abc123",
          snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
        });
        const storage = createMockStorage(session, sandbox);
        const provider = createMockProvider();
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

        expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
          expect.objectContaining({ provider: "openai", model: "gpt-6-sol" })
        );
        expect(session.model).toBe(model);
      }
    );

    it("restoreFromSnapshot() passes empty settings when sandbox_settings is null", async () => {
      const session = createMockSession({ sandbox_settings: null });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

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

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("restoreFromSnapshot() broadcasts tunnel_urls when provider returns them", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(session, sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true as const,
          sandboxId: config.sandboxId,
          lifetime: noLifetime(),
          tunnelUrls: { "3000": "https://tunnel.example.com" },
        })),
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

      expect(storage.calls).toContain("updateSandboxTunnelUrls");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_access_changed")
      ).toBe(true);
    });
  });

  describe("agent slack-notify gate", () => {
    function buildManagerWith(opts: {
      lookup?: SlackAgentNotifyLookup;
      provider?: ReturnType<typeof createMockProvider>;
      sandbox?: ReturnType<typeof createMockSandbox>;
      session?: ReturnType<typeof createMockSession>;
    }) {
      const sandbox =
        opts.sandbox ?? createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(opts.session ?? createMockSession(), sandbox);
      const provider = opts.provider ?? createMockProvider();
      const config = { ...createTestConfig(), slackAgentNotifyLookup: opts.lookup };
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        config
      );
      return { manager, provider };
    }

    function snapshotSandbox() {
      return createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
    }

    it("passes agentSlackNotifyEnabled=true when the lookup returns true", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const { manager, provider } = buildManagerWith({ lookup });

      await manager.spawnSandbox();

      expect(lookup.isEnabledForRepo).toHaveBeenCalledWith("testowner", "testrepo");
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: true })
      );
    });

    it("passes agentSlackNotifyEnabled=false when the lookup returns false", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => false),
      };
      const { manager, provider } = buildManagerWith({ lookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("passes agentSlackNotifyEnabled=false when no lookup is configured (deployment without Slack)", async () => {
      const { manager, provider } = buildManagerWith({});

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("uses the global slack-notify lookup for no-repository sessions", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const session = createMockSession({
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      });
      const { manager, provider } = buildManagerWith({ lookup, session });

      await manager.spawnSandbox();

      expect(lookup.isEnabledForRepo).toHaveBeenCalledWith(null, null);
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: true })
      );
    });

    it("treats lookup failure as disabled and continues spawning", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };
      const { manager, provider } = buildManagerWith({ lookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("passes agentSlackNotifyEnabled=true on snapshot restore when the lookup returns true", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const { manager, provider } = buildManagerWith({ lookup, sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: true })
      );
    });

    it("passes agentSlackNotifyEnabled=false on snapshot restore when the lookup returns false", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => false),
      };
      const { manager, provider } = buildManagerWith({ lookup, sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("passes agentSlackNotifyEnabled=false on snapshot restore when no lookup is configured", async () => {
      const { manager, provider } = buildManagerWith({ sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("uses the global slack-notify lookup for no-repository snapshot restores", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const session = createMockSession({
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      });
      const { manager, provider } = buildManagerWith({
        lookup,
        session,
        sandbox: snapshotSandbox(),
      });

      await manager.spawnSandbox();

      expect(lookup.isEnabledForRepo).toHaveBeenCalledWith(null, null);
      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: true })
      );
    });

    it("treats lookup failure as disabled on snapshot restore and continues spawning", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };
      const { manager, provider } = buildManagerWith({ lookup, sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
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
      await expect(manager.handleAlarm()).resolves.toBe("sandbox_failed");

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

describe("SandboxLifecycleManager log context", () => {
  it("derives session_id from getSessionId per use, upgrading once the id changes", async () => {
    let currentId = "do-fallback-id";
    const mockStorage = createMockStorage(null);
    const getSessionId = vi.fn(() => currentId);
    const manager = createTestLifecycleManager(
      createMockProvider(),
      mockStorage,
      mockStorage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      { ...createTestConfig(), getSessionId }
    );
    expect(getSessionId).not.toHaveBeenCalled();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The no-session spawn guard is the cheapest this.log-emitting operation.
    await manager.spawnSandbox();
    currentId = "public-session-name";
    await manager.spawnSandbox();

    const errorLogs = parseStructuredLogs(errorSpy);
    errorSpy.mockRestore();

    // A constructor-time capture (the pre-composition-root behavior) would
    // stamp both lines with the first id; a latched-first-value memo would
    // never upgrade. Each line must carry the id current at emit time.
    const contexts = errorLogs
      .filter((line) => line.msg === "Cannot spawn sandbox: no session")
      .map((line) => line.session_id);
    expect(contexts).toEqual(["do-fallback-id", "public-session-name"]);
  });

  it("resolves the extracted access logger's session_id only when access is used", async () => {
    let currentId = "do-fallback-id";
    const getSessionId = vi.fn(() => currentId);
    const sandbox = createMockSandbox({ status: "pending" });
    const storage = createMockStorage(createMockSession({ code_server_enabled: 1 }), sandbox);
    const provider = createMockProvider({
      createSandbox: vi.fn(async (config) => ({
        sandboxId: config.sandboxId,
        providerObjectId: "logged-source",
        createdAt: Date.now(),
        lifetime: noLifetime(),
        codeServerUrl: "https://code.test/logged",
        codeServerPassword: "logged-secret",
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
      { ...createTestConfig(), getSessionId }
    );
    expect(getSessionId).not.toHaveBeenCalled();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await manager.spawnSandbox();
      currentId = "public-session-name";
      sandbox.status = "failed";
      sandbox.last_heartbeat = null;
      await manager.spawnSandbox();

      expect(
        parseStructuredLogs(info)
          .filter((entry) => entry.msg === "Storing code-server info")
          .map((entry) => entry.session_id)
      ).toEqual(["do-fallback-id", "public-session-name"]);
    } finally {
      info.mockRestore();
    }
  });

  it("omits session_id entirely when no getSessionId is configured", async () => {
    const mockStorage = createMockStorage(null);
    const manager = createTestLifecycleManager(
      createMockProvider(),
      mockStorage,
      mockStorage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await manager.spawnSandbox();

    const errorLogs = parseStructuredLogs(errorSpy);
    errorSpy.mockRestore();

    const line = errorLogs.find((entry) => entry.msg === "Cannot spawn sandbox: no session");
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty("session_id");
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
