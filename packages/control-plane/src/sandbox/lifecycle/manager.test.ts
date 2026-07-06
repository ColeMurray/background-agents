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
  type RepoImageLookup,
  type SlackAgentNotifyLookup,
} from "./manager";
import {
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
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
  userEnvVars: Record<string, string> | undefined = undefined
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
      supportsWarm: true,
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
      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => ({
          id: "row-1",
          provider_image_id: "repo-image-1",
          base_sha: "abc123",
        })),
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
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: null,
          repoName: null,
          branch: null,
          codeServerEnabled: true,
          agentSlackNotifyEnabled: true,
          repoImageId: null,
          repoImageSha: null,
        })
      );
      expect(mcpServerLookup.getDecryptedForSession).toHaveBeenCalledWith(null, null);
      expect(slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledWith(null, null);
      expect(repoImageLookup.getLatestReady).not.toHaveBeenCalled();
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

    it("surfaces a user-legible error when the snapshot has expired", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => ({
          success: false,
          error: "Snapshot image img-abc123 is no longer available",
          errorCode: "SNAPSHOT_RESTORE_FAILED",
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

      const errorMessage = broadcaster.messages.find(
        (m) => (m as { type: string }).type === "sandbox_error"
      ) as { error: string } | undefined;
      expect(errorMessage?.error).toContain("expired");
      expect(
        storage.calls.some(
          (c) => c.startsWith("setLastSpawnError:") && c.includes("expired") && !c.includes("null")
        )
      ).toBe(true);
    });

    it("keeps the provider error message for non-expiry restore failures", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => ({
          success: false,
          error: "Modal API error: 500",
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

      const errorMessage = broadcaster.messages.find(
        (m) => (m as { type: string }).type === "sandbox_error"
      ) as { error: string } | undefined;
      expect(errorMessage?.error).toBe("Modal API error: 500");
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
        capabilities: { supportsSnapshots: false, supportsRestore: false, supportsWarm: false },
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

  describe("repo image lookup in doSpawn", () => {
    it("passes repoImageId when lookup returns a ready image", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => ({
          id: "row-abc123",
          provider_image_id: "img-abc123",
          base_sha: "sha-def456",
        })),
        markRestoreFailed: vi.fn(async () => true),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: "img-abc123",
          repoImageSha: "sha-def456",
        })
      );
      expect(repoImageLookup.markRestoreFailed).not.toHaveBeenCalled();
    });

    it("marks the ready row failed when the provider reports a restore failure", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider({
        createSandbox: vi.fn(async (config: CreateSandboxConfig) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          imageRestoreFailed: true,
        })),
      });
      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => ({
          id: "row-abc123",
          provider_image_id: "img-abc123",
          base_sha: "sha-def456",
        })),
        markRestoreFailed: vi.fn(async () => true),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(repoImageLookup.markRestoreFailed).toHaveBeenCalledWith(
        "row-abc123",
        expect.any(String)
      );
      // The spawn itself succeeded — the sandbox booted from base.
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
    });

    it("does not mark anything when the flag is set but no image was requested", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider({
        createSandbox: vi.fn(async (config: CreateSandboxConfig) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          imageRestoreFailed: true,
        })),
      });
      const repoImageLookup: RepoImageLookup = {
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
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(repoImageLookup.markRestoreFailed).not.toHaveBeenCalled();
    });

    it("continues the spawn when marking the restore failure throws", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider({
        createSandbox: vi.fn(async (config: CreateSandboxConfig) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          imageRestoreFailed: true,
        })),
      });
      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => ({
          id: "row-abc123",
          provider_image_id: "img-abc123",
          base_sha: "sha-def456",
        })),
        markRestoreFailed: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxStatus:connecting");
    });

    it("passes null repoImageId when no ready image exists", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => null),
        markRestoreFailed: vi.fn(async () => true),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: null,
          repoImageSha: null,
        })
      );
    });

    it("falls back gracefully when repo image lookup fails", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
        markRestoreFailed: vi.fn(async () => true),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      // Should still spawn, just without repo image
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: null,
          repoImageSha: null,
        })
      );
    });

    it("passes session base_branch to repo image lookup", async () => {
      const session = createMockSession({ base_branch: "feature/xyz" });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
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
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(repoImageLookup.getLatestReady).toHaveBeenCalledWith(
        "testowner",
        "testrepo",
        "feature/xyz"
      );
    });

    it("passes null repoImageId when no lookup is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      // No repoImageLookup provided
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

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: null,
          repoImageSha: null,
        })
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
