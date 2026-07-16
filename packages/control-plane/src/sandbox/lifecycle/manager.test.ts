/**
 * Unit tests for SandboxLifecycleManager.
 *
 * Uses mocked dependencies to test lifecycle orchestration logic.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
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
import type { SandboxRow, SessionRow } from "../../session/types";
import type { SandboxStatus } from "../../types";

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
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
    created_at: Date.now() - 60000,
    spawn_failure_count: 0,
    last_spawn_failure: 0,
    ...overrides,
  };
}

function createMockStorage(
  session: SessionRow | null = createMockSession(),
  sandbox:
    | (SandboxRow & { spawn_failure_count: number; last_spawn_failure: number })
    | null = createMockSandbox(),
  userEnvVars: Record<string, string> | undefined = undefined,
  sessionRepositories: SessionRepositoryInfo[] = []
): SandboxStorage & { calls: string[] } {
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
    updateSandboxForSpawn: vi.fn((data) => {
      calls.push("updateSandboxForSpawn");
      if (sandbox) {
        sandbox.status = data.status;
        sandbox.created_at = data.createdAt;
        sandbox.auth_token_hash = data.authTokenHash;
        sandbox.auth_token = null;
        sandbox.modal_sandbox_id = data.modalSandboxId;
        sandbox.modal_object_id = null;
      }
    }),
    updateSandboxModalObjectId: vi.fn((id: string) => {
      calls.push(`updateSandboxModalObjectId:${id}`);
      if (sandbox) sandbox.modal_object_id = id;
    }),
    updateSandboxSnapshotImageId: vi.fn((sandboxId: string, imageId: string) => {
      calls.push(`updateSandboxSnapshotImageId:${imageId}`);
      if (sandbox) sandbox.snapshot_image_id = imageId;
    }),
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
    updateSandboxCodeServer: vi.fn(async (url: string, password: string) => {
      calls.push(`updateSandboxCodeServer:${url}`);
      if (sandbox) {
        sandbox.code_server_url = url;
        sandbox.code_server_password = password;
      }
    }),
    clearSandboxCodeServer: vi.fn(() => {
      calls.push("clearSandboxCodeServer");
      if (sandbox) {
        sandbox.code_server_url = null;
        sandbox.code_server_password = null;
      }
    }),
    clearSandboxCodeServerUrl: vi.fn(() => {
      calls.push("clearSandboxCodeServerUrl");
      if (sandbox) {
        sandbox.code_server_url = null;
      }
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
    updateSandboxTtyd: vi.fn(async (url: string, token: string) => {
      calls.push("updateSandboxTtyd");
      if (sandbox) {
        sandbox.ttyd_url = url;
        sandbox.ttyd_token = token;
      }
    }),
    clearSandboxTtyd: vi.fn(() => {
      calls.push("clearSandboxTtyd");
      if (sandbox) {
        sandbox.ttyd_url = null;
        sandbox.ttyd_token = null;
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
    closeSandboxWebSocket: vi.fn(),
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
    scheduleAlarm: vi.fn(async (timestamp: number) => {
      alarms.push(timestamp);
    }),
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
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_status")
      ).toBe(true);
    });

    it("logs one terminal sandbox.spawn event for success", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
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
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:provider-obj-123");
      expect(
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/provider-obj-123",
        },
      ]);
    });

    it("does not broadcast sandbox_dashboard_url when no builder is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
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
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toBe(false);
    });

    it("schedules connecting timeout alarm after spawn", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.spawnSandbox();
      const after = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const scheduledTime = alarmScheduler.alarms[0];
      expect(scheduledTime).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
      expect(scheduledTime).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
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
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        {
          ...createTestConfig(),
          mcpServerLookup,
          slackAgentNotifyLookup,
        },
        {},
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
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
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

    it("logs one terminal sandbox.restore event for success", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        createMockStorage(createMockSession(), sandbox),
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
      });
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
        createMockStorage(createMockSession(), sandbox),
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

    it("schedules connecting timeout alarm after restore", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.spawnSandbox();
      const after = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const scheduledTime = alarmScheduler.alarms[0];
      expect(scheduledTime).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
      expect(scheduledTime).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
    });

    it("stores providerObjectId after successful restore for future snapshots", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
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
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:restored-obj-456");
      expect(
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/restored-obj-456",
        },
      ]);
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
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/new-provider-obj",
        },
      ]);
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
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/same-provider-obj",
        },
      ]);
    });

    it("resets isSpawningSandbox flag after restore throws error", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
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
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("resets isSpawningSandbox flag after restore returns failure", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
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
      expect(storage.calls).toContain("updateSandboxStatus:failed");
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
      expect(statusCalls).toContain("updateSandboxStatus:connecting");
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
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
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
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).not.toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
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
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxStatus:failed");
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
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.triggerSnapshot("test_reason");

      expect(provider.takeSnapshot).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxSnapshotImageId:snapshot-img-123");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "snapshot_saved")
      ).toBe(true);
    });

    it("skips when provider does not support snapshots", async () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider: SandboxProvider = {
        name: "no-snapshot",
        capabilities: { supportsSnapshots: false, supportsRestore: false },
        createSandbox: vi.fn(),
        // No takeSnapshot method
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.triggerSnapshot("test_reason");

      // Should not crash, just skip
      expect(storage.calls).not.toContain("updateSandboxSnapshotImageId");
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
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.triggerSnapshot("execution_complete");

      expect(storage.calls).toContain("updateSandboxSnapshotImageId:custom-snapshot-id");
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
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      // Should not throw
      await manager.triggerSnapshot("test");

      expect(storage.calls).not.toContain("updateSandboxSnapshotImageId");
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
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:stale");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "stale")).toBe(
        true
      );
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(wsManager.closeSandboxWebSocket).toHaveBeenCalledWith(1000, "Heartbeat stale");
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
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

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
      expect(storage.calls).toContain("clearSandboxCodeServer");
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
      expect(storage.calls).toContain("clearSandboxCodeServerUrl");
      expect(storage.calls).not.toContain("clearSandboxCodeServer");
    });

    it("calls onSandboxTerminating callback on heartbeat stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // Past 90s timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledOnce();
    });

    it("calls onSandboxTerminating callback on inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000, // Recent heartbeat
        last_activity: now - 11 * 60 * 1000, // Past 10 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false, 0), // No clients
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledOnce();
    });

    it("does not call onSandboxTerminating when no callback provided", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);

      // No callbacks - should not throw
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();
      expect(storage.calls).toContain("updateSandboxStatus:stale");
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
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(storage.calls).toContain("clearSandboxCodeServer");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "failed")).toBe(
        true
      );
      expect(
        broadcaster.messages.some((m) => (m as { type?: string }).type === "sandbox_error")
      ).toBe(true);
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

    it("calls onSandboxTerminating callback on connecting timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000,
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledOnce();
    });
  });

  describe("scheduleDisconnectCheck", () => {
    it("schedules alarm at heartbeat timeout from now", async () => {
      const storage = createMockStorage();
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
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
        runtime_version: "v53-list-native-runtime",
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
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
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
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
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
        runtime_version: "v53-list-native-runtime",
        ...overrides,
      };
    }

    function createEnvironmentSessionManager(overrides?: {
      provider?: SandboxProvider;
      environmentImageLookup?: ImageBuildLookup;
      sessionRepositories?: SessionRepositoryInfo[];
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
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
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
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
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
      const { manager, storage } = createEnvironmentSessionManager({
        environmentImageLookup,
        provider: createMockProvider({ createSandbox }),
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
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
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
      expect(storage.calls).toContain("updateSandboxStatus:failed");
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
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
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
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        { ...createTestConfig(), mcpServerLookup: overrides?.mcpServerLookup },
        {},
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
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxTunnelUrls");
      expect(
        broadcaster.messages.some(
          (m) =>
            (m as { type: string }).type === "tunnel_urls" &&
            (m as { urls: Record<string, string> }).urls["3000"] === "https://tunnel.example.com"
        )
      ).toBe(true);
    });

    it("restoreFromSnapshot() passes sandboxSettings from session to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
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
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
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
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxTunnelUrls");
      expect(
        broadcaster.messages.some(
          (m) =>
            (m as { type: string }).type === "tunnel_urls" &&
            (m as { urls: Record<string, string> }).urls["3000"] === "https://tunnel.example.com"
        )
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
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );
      return { manager, provider };
    }

    function snapshotSandbox() {
      return createMockSandbox({ status: "stopped", snapshot_image_id: "img-abc123" });
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
