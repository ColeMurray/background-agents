/**
 * Unit tests for SandboxLifecycleManager.
 *
 * Uses mocked dependencies to test lifecycle orchestration logic.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxGeneration,
  type SandboxStorage,
  type SessionContextReader,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
  type SandboxLifecycleConfig,
  type McpServerLookup,
  type ImageBuildLookup,
  type SlackAgentNotifyLookup,
} from "./manager";
import type { ImageBuildSpawnRow } from "./image-selection";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
  type SessionRepositoryInfo,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";
import type { SandboxAccessKind, SandboxRow, SessionRow } from "../../session/types";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import { hashToken } from "../../auth/crypto";
import type * as AuthCrypto from "../../auth/crypto";

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

// ==================== Mock Factories ====================

function createMockSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-123",
    session_name: "test-session",
    title: "Test Session",
    repo_owner: "testowner",
    repo_name: "testrepo",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: Date.now() - 60000,
    updated_at: Date.now(),
    ...overrides,
  };
}

function createMockSandbox(
  overrides: Partial<SandboxRow & { spawn_failure_count: number; last_spawn_failure: number }> = {}
): SandboxRow & { spawn_failure_count: number; last_spawn_failure: number } {
  return {
    id: "sandbox-123",
    modal_sandbox_id: "sandbox-testowner-testrepo-123",
    modal_object_id: "modal-obj-123",
    snapshot_id: null,
    snapshot_image_id: null,
    snapshot_runtime_version: null,
    runtime_version: COMPATIBLE_RUNTIME_VERSION,
    auth_token: "auth-token-123",
    auth_token_hash: "auth-token-hash-123",
    status: "ready",
    git_sync_status: "completed",
    last_heartbeat: Date.now() - 10000,
    last_activity: Date.now() - 30000,
    last_spawn_error: null,
    last_spawn_error_at: null,
    code_server_url: null,
    code_server_password: null,
    vnc_url: null,
    vnc_password: null,
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
    active_socket_id: null,
    created_at: Date.now() - 60000,
    spawn_failure_count: 0,
    last_spawn_failure: 0,
    ...overrides,
  };
}

const ACCESS_FIELDS = {
  codeServer: { url: "code_server_url", secret: "code_server_password" },
  vnc: { url: "vnc_url", secret: "vnc_password" },
  ttyd: { url: "ttyd_url", secret: "ttyd_token" },
} as const;

function createMockStorage(
  session: SessionRow | null = createMockSession(),
  sandbox:
    | (SandboxRow & { spawn_failure_count: number; last_spawn_failure: number })
    | null = createMockSandbox(),
  userEnvVars: Record<string, string> | undefined = undefined,
  sessionRepositories: SessionRepositoryInfo[] = []
): SandboxStorage & SessionContextReader & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    getSandbox: vi.fn(() => {
      calls.push("getSandbox");
      return sandbox;
    }),
    getSandboxWithCircuitBreaker: vi.fn(() => {
      calls.push("getSandboxWithCircuitBreaker");
      return sandbox;
    }),
    getSession: vi.fn(() => {
      calls.push("getSession");
      return session;
    }),
    getSessionRepositories: vi.fn(() => {
      calls.push("getSessionRepositories");
      return sessionRepositories;
    }),
    getUserEnvVars: vi.fn(async () => {
      calls.push("getUserEnvVars");
      return userEnvVars;
    }),
    updateSandboxStatus: vi.fn((status: SandboxStatus) => {
      calls.push(`updateSandboxStatus:${status}`);
      if (sandbox) sandbox.status = status;
    }),
    transitionSandboxStatus: vi.fn(
      (generation: SandboxGeneration, from: SandboxStatus, to: SandboxStatus) => {
        calls.push(`transitionSandboxStatus:${from}->${to}`);
        if (
          !sandbox ||
          sandbox.modal_sandbox_id !== generation.sandboxId ||
          sandbox.created_at !== generation.createdAt ||
          sandbox.status !== from
        ) {
          return false;
        }
        sandbox.status = to;
        return true;
      }
    ),
    updateSandboxForSpawn: vi.fn((data) => {
      calls.push("updateSandboxForSpawn");
      if (sandbox) {
        sandbox.status = data.status;
        sandbox.created_at = data.createdAt;
        sandbox.auth_token_hash = "";
        sandbox.auth_token = null;
        sandbox.modal_sandbox_id = data.modalSandboxId;
        sandbox.runtime_version = null;
        if (!data.preserveProviderObjectId) sandbox.modal_object_id = null;
      }
    }),
    updateSandboxAuthTokenHash: vi.fn((modalSandboxId: string, authTokenHash: string) => {
      calls.push("updateSandboxAuthTokenHash");
      if (
        !sandbox ||
        sandbox.modal_sandbox_id !== modalSandboxId ||
        sandbox.status !== "spawning"
      ) {
        return false;
      }
      sandbox.auth_token_hash = authTokenHash;
      return true;
    }),
    updateSandboxForResume: vi.fn((data) => {
      calls.push(`updateSandboxForResume:${data.status}`);
      if (sandbox) {
        sandbox.status = data.status;
        sandbox.created_at = data.createdAt;
      }
    }),
    updateSandboxModalObjectId: vi.fn((id: string | null) => {
      calls.push(`updateSandboxModalObjectId:${id}`);
      if (sandbox) sandbox.modal_object_id = id;
    }),
    updateSandboxRuntimeVersion: vi.fn((runtimeVersion: string | null) => {
      calls.push(`updateSandboxRuntimeVersion:${runtimeVersion}`);
      if (sandbox) sandbox.runtime_version = runtimeVersion;
    }),
    recordSandboxSnapshot: vi.fn(
      (sandboxId: string | null, imageId: string, runtimeVersion: string | null) => {
        calls.push(`recordSandboxSnapshot:${imageId}:${runtimeVersion}`);
        if (!sandbox || sandbox.modal_sandbox_id !== sandboxId) return false;
        sandbox.snapshot_image_id = imageId;
        sandbox.snapshot_runtime_version = runtimeVersion;
        return true;
      }
    ),
    updateSandboxLastActivity: vi.fn((timestamp: number) => {
      calls.push("updateSandboxLastActivity");
      if (sandbox) sandbox.last_activity = timestamp;
    }),
    incrementCircuitBreakerFailure: vi.fn((timestamp: number) => {
      calls.push("incrementCircuitBreakerFailure");
      if (sandbox) {
        sandbox.spawn_failure_count++;
        sandbox.last_spawn_failure = timestamp;
      }
    }),
    resetCircuitBreaker: vi.fn(() => {
      calls.push("resetCircuitBreaker");
      if (sandbox) {
        sandbox.spawn_failure_count = 0;
        sandbox.last_spawn_failure = 0;
      }
    }),
    setLastSpawnError: vi.fn((error: string | null, timestamp: number | null) => {
      calls.push(`setLastSpawnError:${error ?? "null"}`);
      if (sandbox) {
        sandbox.last_spawn_error = error;
        sandbox.last_spawn_error_at = timestamp;
      }
    }),
    updateSandboxAccess: vi.fn(async (kind: SandboxAccessKind, url: string, secret: string) => {
      calls.push(`updateSandboxAccess:${kind}:${url}`);
      if (sandbox) {
        sandbox[ACCESS_FIELDS[kind].url] = url;
        sandbox[ACCESS_FIELDS[kind].secret] = secret;
      }
    }),
    clearSandboxAccess: vi.fn((kind: SandboxAccessKind) => {
      calls.push(`clearSandboxAccess:${kind}`);
      if (sandbox) {
        sandbox[ACCESS_FIELDS[kind].url] = null;
        sandbox[ACCESS_FIELDS[kind].secret] = null;
      }
    }),
    clearSandboxAccessUrl: vi.fn((kind: SandboxAccessKind) => {
      calls.push(`clearSandboxAccessUrl:${kind}`);
      if (sandbox) sandbox[ACCESS_FIELDS[kind].url] = null;
    }),
    updateSandboxTunnelUrls: vi.fn(async (urls: Record<string, string>) => {
      calls.push(`updateSandboxTunnelUrls`);
      if (sandbox) {
        sandbox.tunnel_urls = JSON.stringify(urls);
      }
    }),
    clearSandboxTunnelUrls: vi.fn(() => {
      calls.push("clearSandboxTunnelUrls");
      if (sandbox) {
        sandbox.tunnel_urls = null;
      }
    }),
  };
}

function createMockBroadcaster(): SandboxBroadcaster & { messages: object[] } {
  const messages: object[] = [];
  return {
    messages,
    broadcast: vi.fn((message: object) => {
      messages.push(message);
    }),
  };
}

function createMockWebSocketManager(
  hasSandboxWs = false,
  clientCount = 0
): WebSocketManager & { sendCalls: object[] } {
  const sendCalls: object[] = [];
  return {
    sendCalls,
    getSandboxWebSocket: vi.fn(() => (hasSandboxWs ? ({} as WebSocket) : null)),
    detachSandboxWebSocket: vi.fn(),
    sendToSandbox: vi.fn((message: object) => {
      sendCalls.push(message);
      return true;
    }),
    getConnectedClientCount: vi.fn(() => clientCount),
  };
}

function createMockAlarmScheduler(): AlarmScheduler & { alarms: number[] } {
  const alarms: number[] = [];
  return {
    alarms,
    schedule: vi.fn(async (timestamp: number) => {
      alarms.push(timestamp);
    }),
    cancel: vi.fn(async () => {}),
    current: vi.fn(async () => alarms[alarms.length - 1] ?? null),
  };
}

function createMockIdGenerator(): IdGenerator {
  let counter = 0;
  return {
    generateId: vi.fn(() => `generated-id-${++counter}`),
  };
}

function parseStructuredLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>
  );
}

function createMockProvider(
  overrides: Partial<{
    createSandbox: (config: CreateSandboxConfig) => Promise<CreateSandboxResult>;
    restoreFromSnapshot: (config: RestoreConfig) => Promise<RestoreResult>;
    resumeSandbox: (config: ResumeConfig) => Promise<ResumeResult>;
    takeSnapshot: (config: SnapshotConfig) => Promise<SnapshotResult>;
    stopSandbox: (config: StopConfig) => Promise<StopResult>;
    capabilities: Partial<SandboxProvider["capabilities"]>;
  }> = {}
): SandboxProvider {
  const provider: SandboxProvider = {
    name: "mock",
    capabilities: {
      supportsSandboxTimeout: true,
      supportsSnapshots: true,
      supportsRestore: true,
      ...overrides.capabilities,
    },
    createSandbox:
      overrides.createSandbox ||
      vi.fn(async (config: CreateSandboxConfig) => ({
        sandboxId: config.sandboxId,
        providerObjectId: "provider-obj-123",
        status: "connecting",
        createdAt: Date.now(),
      })),
    restoreFromSnapshot:
      overrides.restoreFromSnapshot ||
      vi.fn(async (config: RestoreConfig) => ({
        success: true,
        sandboxId: config.sandboxId,
      })),
    takeSnapshot:
      overrides.takeSnapshot ||
      vi.fn(async () => ({
        success: true,
        imageId: "snapshot-img-123",
      })),
  };
  if (overrides.resumeSandbox) {
    provider.resumeSandbox = overrides.resumeSandbox;
  }
  if (overrides.stopSandbox) {
    provider.stopSandbox = overrides.stopSandbox;
  }
  return provider;
}

function createTestConfig(): SandboxLifecycleConfig {
  return {
    ...DEFAULT_LIFECYCLE_CONFIG,
    controlPlaneUrl: "https://test.workers.dev",
    model: "anthropic/claude-sonnet-4-5",
  };
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
        ...access,
      };
    }),
    restoreFromSnapshot: vi.fn(async (config) => {
      connectBridge();
      return { success: true, sandboxId: config.sandboxId, ...access };
    }),
    resumeSandbox: vi.fn(async () => {
      connectBridge();
      return { success: true, ...access };
    }),
  });
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

describe("SandboxLifecycleManager", () => {
  describe("spawnSandbox", () => {
    it("spawns when all conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const alarmScheduler = createMockAlarmScheduler();
      const idGenerator = createMockIdGenerator();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
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
        const manager = new SandboxLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(false),
          alarmScheduler,
          createMockIdGenerator(),
          createTestConfig()
        );

        await manager.spawnSandbox();

        expect(calls.slice(0, 4)).toEqual(["fence", "alarm", "stop", "clear"]);
        expect(stopSandbox).toHaveBeenCalledWith(
          expect.objectContaining({
            providerObjectId: "modal-obj-123",
            sessionId: "test-session",
            reason: "respawn",
            signal: expect.any(AbortSignal),
          })
        );
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
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          createSandbox: vi.fn(async (config) => ({
            sandboxId: config.sandboxId,
            status: "connecting",
            createdAt: Date.now(),
          })),
          stopSandbox: vi.fn(async () => {
            throw new Error("provider unavailable");
          }),
        });
        const manager = new SandboxLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(false),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createTestConfig()
        );
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await manager.spawnSandbox();

        expect(storage.updateSandboxForSpawn).toHaveBeenCalledOnce();
        expect(sandbox.modal_object_id).toBe("modal-obj-123");
        expect(
          kind === "spawn" ? provider.createSandbox : provider.restoreFromSnapshot
        ).toHaveBeenCalledOnce();
        expect(storage.transitionSandboxStatus).toHaveBeenCalledWith(
          expect.objectContaining({ sandboxId: expect.any(String) }),
          "spawning",
          "connecting"
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
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
          createSandbox: vi.fn(async (config) => ({
            sandboxId: config.sandboxId,
            status: "connecting",
            createdAt: Date.now(),
          })),
          stopSandbox: vi.fn(() => new Promise<StopResult>(() => {})),
        });
        const manager = new SandboxLifecycleManager(
          provider,
          storage,
          storage,
          createMockBroadcaster(),
          createMockWebSocketManager(false),
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createTestConfig()
        );
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const spawning = manager.spawnSandbox();
        await vi.waitFor(() => expect(provider.stopSandbox).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(10_000);
        await spawning;

        expect(provider.createSandbox).toHaveBeenCalledOnce();
        expect(storage.transitionSandboxStatus).toHaveBeenCalledWith(
          expect.objectContaining({ sandboxId: expect.any(String) }),
          "spawning",
          "connecting"
        );
        expect(sandbox.modal_object_id).toBe("modal-obj-123");
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
          vncAccess: { url: "https://vnc.test", password: "secret" },
        })),
      });
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

    it("logs one terminal sandbox.spawn event for success", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:provider-obj-123");
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

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:provider-obj-123");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_access_changed")
      ).toBe(false);
    });

    it("schedules the connecting timeout from the persisted startup timestamp", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
          success: true,
          sandboxId: config.sandboxId,
          providerObjectId: "restored-object",
        })),
      });
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
          success: true,
          sandboxId: config.sandboxId,
          providerObjectId: "new-modal-obj-after-restore",
        })),
      });

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

      await manager.spawnSandbox();

      // Verify providerObjectId was stored for future snapshots
      expect(storage.calls).toContain("updateSandboxModalObjectId:new-modal-obj-after-restore");
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
          success: true,
          sandboxId: config.sandboxId,
          providerObjectId: "restored-obj-456",
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:restored-obj-456");
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
          success: true,
          providerObjectId: "new-provider-obj",
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxModalObjectId:new-provider-obj");
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
          success: true,
          providerObjectId: "same-provider-obj",
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalled();
      expect(storage.calls).not.toContain("updateSandboxModalObjectId:same-provider-obj");
      expect(
        broadcaster.messages.filter(
          (m) => (m as { type: string }).type === "sandbox_access_changed"
        )
      ).toContainEqual({ type: "sandbox_access_changed" });
    });

    it("does not carry a predecessor's runtime version onto a replacement's snapshot", async () => {
      // The row starts out describing a sandbox that reported a compatible
      // runtime. Once it is replaced, a snapshot the replacement takes must be
      // stamped unknown until the new sandbox reports for itself — otherwise a
      // downgraded or silent runtime inherits a clean bill of health.
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalled();
      expect(storage.calls).toContain(`updateSandboxRuntimeVersion:${COMPATIBLE_RUNTIME_VERSION}`);
      expect(sandbox.runtime_version).toBe(COMPATIBLE_RUNTIME_VERSION);
    });

    it("spawns fresh instead of restoring a snapshot taken by a retired runtime", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: "v1-retired",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(provider.createSandbox).toHaveBeenCalled();
    });

    it("spawns fresh when the snapshot predates runtime-version recording", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider();
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(provider.createSandbox).toHaveBeenCalled();
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

      await manager.spawnSandbox();

      // Should go: pending -> spawning -> connecting
      const statusCalls = storage.calls.filter((c) => c.startsWith("updateSandbox"));
      expect(statusCalls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
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

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  describe("triggerSnapshot", () => {
    it("takes snapshot when provider supports it", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
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

      // Should not throw
      await manager.triggerSnapshot("test");

      expect(storage.calls).not.toContain("recordSandboxSnapshot");
    });
  });

  describe("handleAlarm", () => {
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
        created_at: now - 130_000, // 130s ago, past 120s timeout
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

    it("does not timeout connecting sandbox within timeout window", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 30_000, // 30s ago, well within 120s timeout
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

  describe("terminateUnresponsiveSandbox", () => {
    it.each([
      ["prompt_dispatch_send_failed", "Prompt dispatch send failed"],
      ["stop_send_failed", "Stop command send failed"],
      ["stop_confirmation_timeout", "Stop confirmation timed out"],
    ] as const)(
      "uses the %s reason for provider stop and socket close",
      async (trigger, closeReason) => {
        const storage = createMockStorage();
        const wsManager = createMockWebSocketManager(true);
        const stopSandbox = vi.fn(async () => ({ success: true }));
        const provider = createMockProvider({
          capabilities: { supportsExplicitStop: true },
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

        await manager.terminateUnresponsiveSandbox(trigger);

        expect(stopSandbox).toHaveBeenCalledWith(expect.objectContaining({ reason: trigger }));
        expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(1011, closeReason);
      }
    );

    it("detaches dispatch before awaiting a paused provider stop", async () => {
      let resolveStop!: (result: StopResult) => void;
      const providerStop = new Promise<StopResult>((resolve) => {
        resolveStop = resolve;
      });
      const wsManager = createMockWebSocketManager(true);
      const mockStorage = createMockStorage();
      const manager = new SandboxLifecycleManager(
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
        createTestConfig()
      );
      const terminating = manager.terminateUnresponsiveSandbox("stop_confirmation_timeout");
      let completed = false;
      void terminating.then(() => {
        completed = true;
      });

      expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(
        1011,
        "Stop confirmation timed out"
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
      const manager = new SandboxLifecycleManager(
        createMockProvider({
          capabilities: { supportsExplicitStop: true },
          stopSandbox,
          createSandbox,
        }),
        storage,
        storage,
        createMockBroadcaster(),
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const termination = manager.terminateFailedSandbox("OpenCode repeatedly crashed");

      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(
        1011,
        "Fatal sandbox runtime error"
      );
      expect(manager.isSpawning()).toBe(true);
      await manager.spawnSandbox();
      expect(createSandbox).not.toHaveBeenCalled();

      resolveStop({ success: true });
      await expect(termination).resolves.toBe(true);
      expect(manager.isSpawning()).toBe(false);
    });

    it.each(["stopped", "stale"] as const)(
      "does not overwrite or detach a %s sandbox",
      async (status) => {
        const storage = createMockStorage(createMockSession(), createMockSandbox({ status }));
        const wsManager = createMockWebSocketManager(true);
        const manager = new SandboxLifecycleManager(
          createMockProvider(),
          storage,
          storage,
          createMockBroadcaster(),
          wsManager,
          createMockAlarmScheduler(),
          createMockIdGenerator(),
          createTestConfig()
        );

        await expect(manager.terminateFailedSandbox("Delayed failure")).resolves.toBe(false);

        expect(storage.calls).not.toContain("updateSandboxStatus:failed");
        expect(wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
      }
    );
  });

  describe("scheduleDisconnectCheck", () => {
    it("schedules alarm at heartbeat timeout from now", async () => {
      const storage = createMockStorage();
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
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

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("skips when status is spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
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

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("calls spawnSandbox when conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
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

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
        getLatestReady: vi.fn(async () => repoImageRow({ runtime_version: "v52-legacy" })),
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

    it("marks the repo image restore-failed and retries from base when the provider rejects it", async () => {
      // Deliberate behavior change: the old repo path failed the spawn
      // outright; repo images now take the same restore fallback the
      // environment side has.
      const imageBuildLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => repoImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValueOnce(new Error("image expired"))
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
        }));
      const { manager, storage } = createRepoSessionManager({
        imageBuildLookup,
        provider: createMockProvider({ createSandbox }),
      });

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
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
      expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        overrides?.alarmScheduler ?? createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
    });

    it("boots from base when no environment image lookup is bound", async () => {
      const { manager, provider } = createEnvironmentSessionManager();

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ prebuiltImageId: null, prebuiltImageSha: null })
      );
    });

    it("marks the image restore-failed and retries from base when the provider rejects it", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => envImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValueOnce(new Error("image expired"))
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
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
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
      expect(storage.calls).not.toContain("transitionSandboxStatus:spawning->failed");
    });

    it("fails the spawn when the base-image retry also fails", async () => {
      const environmentImageLookup: ImageBuildLookup = {
        getLatestReady: vi.fn(async () => envImageRow()),
        markRestoreFailed: vi.fn(async () => true),
      };
      const createSandbox = vi
        .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
        .mockRejectedValue(new Error("quota exceeded"));
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
        .mockRejectedValueOnce(new Error("image expired"))
        .mockImplementation(async (config) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
        }));
      const { manager, storage } = createEnvironmentSessionManager({
        environmentImageLookup,
        provider: createMockProvider({ createSandbox }),
      });

      await manager.spawnSandbox();

      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
        resumeSandbox: vi.fn(async () => ({ success: true })),
      });
      const mockStorage = createMockStorage(session, sandbox);
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(broadcaster.messages).toContainEqual({
        type: "sandbox_error",
        error: "mock does not support configurable sandbox timeouts",
      });
    });

    it("uses the provider default for child sessions on unsupported providers", async () => {
      const session = createMockSession({ spawn_source: "agent", sandbox_settings: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const provider = createMockProvider({
        capabilities: { supportsSandboxTimeout: false },
      });
      const mockStorage = createMockStorage(session, sandbox);
      const manager = new SandboxLifecycleManager(
        provider,
        mockStorage,
        mockStorage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
          tunnelUrls: { "3000": "https://tunnel.example.com" },
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("restoreFromSnapshot() passes empty settings when sandbox_settings is null", async () => {
      const session = createMockSession({ sandbox_settings: null });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
          success: true,
          sandboxId: config.sandboxId,
          tunnelUrls: { "3000": "https://tunnel.example.com" },
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
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
    const manager = new SandboxLifecycleManager(
      createMockProvider({ createSandbox }),
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createTestConfig()
    );
    return { storage, broadcaster, manager };
  }

  it("does not resurrect an attempt the alarm failed while the provider call was in flight", async () => {
    const sandbox = createMockSandbox({ status: "failed" });
    const { storage, broadcaster, manager } = harness(sandbox, async (config) => {
      // Connecting timeout fired: the alarm failed the attempt and told the user.
      sandbox.status = "failed";
      return {
        sandboxId: config.sandboxId,
        providerObjectId: "provider-obj-late",
        status: "connecting",
        createdAt: Date.now(),
      };
    });

    await manager.spawnSandbox();

    expect(sandbox.status).toBe("failed");
    expect(storage.calls).toContain("transitionSandboxStatus:spawning->connecting");
    expect(broadcaster.messages).not.toContainEqual({
      type: "sandbox_status",
      status: "connecting",
    });
    // The provider-side sandbox exists and a later stop needs its handle.
    expect(sandbox.modal_object_id).toBe("provider-obj-late");
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
    const manager = new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(false),
      alarmScheduler,
      createMockIdGenerator(),
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
        };
      }),
    });
    const manager = new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
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
    const manager = new SandboxLifecycleManager(
      createMockProvider(),
      mockStorage,
      mockStorage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      { ...createTestConfig(), getSessionId: () => currentId }
    );
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

  it("omits session_id entirely when no getSessionId is configured", async () => {
    const mockStorage = createMockStorage(null);
    const manager = new SandboxLifecycleManager(
      createMockProvider(),
      mockStorage,
      mockStorage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
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
    const manager = new SandboxLifecycleManager(
      createMockProvider(),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
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
