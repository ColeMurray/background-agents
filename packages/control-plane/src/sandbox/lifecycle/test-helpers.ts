import { vi } from "vitest";
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
  type SandboxShutdownLifecycle,
} from "./manager";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { SandboxShutdownCoordinator } from "../../session/sandbox-shutdown";
import type { ShutdownRecord } from "../../session/sandbox-shutdown-repository";
import type {
  SandboxProvider,
  SandboxLifetime,
  CreateSandboxConfig,
  CreateSandboxResult,
  RestoreConfig,
  RestoreResult,
  ResumeConfig,
  ResumeResult,
  SessionRepositoryInfo,
  SnapshotConfig,
  SnapshotResult,
  StopConfig,
  StopResult,
} from "../provider";
import type { SandboxAccessKind, SandboxRow, SessionRow } from "../../session/types";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";

export function createMockSession(overrides: Partial<SessionRow> = {}): SessionRow {
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
    agent_session_id: null,
    harness: "opencode" as const,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    status_revision: 1,
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    max_cost_usd: null,
    budget_exhausted: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: Date.now() - 60000,
    updated_at: Date.now(),
    ...overrides,
  };
}

export function createMockSandbox(
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
    boot_phase: null,
    boot_seq: null,
    fenced: 0,
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

export function createMockStorage(
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
    markSandboxReady: vi.fn(() => true),
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
    commitProviderStartup: vi.fn((generation, providerObjectId, allowFailedSelfHeal) => {
      calls.push("commitProviderStartup");
      if (
        !sandbox ||
        sandbox.modal_sandbox_id !== generation.sandboxId ||
        sandbox.created_at !== generation.createdAt ||
        sandbox.fenced !== 0 ||
        !(
          ["spawning", "connecting", "ready"].includes(sandbox.status) ||
          (allowFailedSelfHeal && sandbox.status === "failed")
        )
      ) {
        return null;
      }
      if (providerObjectId !== null) sandbox.modal_object_id = providerObjectId;
      if (sandbox.status === "spawning") sandbox.status = "connecting";
      return sandbox.status;
    }),
    updateSandboxForSpawn: vi.fn((data) => {
      calls.push("updateSandboxForSpawn");
      if (sandbox) {
        sandbox.status = data.status;
        sandbox.created_at = data.createdAt;
        sandbox.auth_token_hash = "";
        sandbox.auth_token = null;
        sandbox.last_heartbeat = null;
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
    fenceSandboxGeneration: vi.fn(() => {
      calls.push("fenceSandboxGeneration");
      if (sandbox) {
        sandbox.auth_token_hash = "";
        sandbox.auth_token = null;
        sandbox.active_socket_id = "";
        sandbox.fenced = 1;
      }
    }),
  };
}

export function createMockBroadcaster(): SandboxBroadcaster & { messages: object[] } {
  const messages: object[] = [];
  return {
    messages,
    broadcast: vi.fn((message: object) => {
      messages.push(message);
    }),
  };
}

export function createMockWebSocketManager(
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

export function createMockAlarmScheduler(): AlarmScheduler & { alarms: number[] } {
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

export function createMockIdGenerator(): IdGenerator {
  let counter = 0;
  return {
    generateId: vi.fn(() => `generated-id-${++counter}`),
  };
}

export function noLifetime(): SandboxLifetime {
  return { kind: "none", observedAtMs: Date.now() };
}

export function createMockProvider(
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
        lifetime: noLifetime(),
      })),
    restoreFromSnapshot:
      overrides.restoreFromSnapshot ||
      vi.fn(async (config: RestoreConfig) => ({
        success: true as const,
        sandboxId: config.sandboxId,
        lifetime: noLifetime(),
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

export function createTestConfig(): SandboxLifecycleConfig {
  return {
    ...DEFAULT_LIFECYCLE_CONFIG,
    controlPlaneUrl: "https://test.workers.dev",
    model: "anthropic/claude-sonnet-4-5",
  };
}

export function createUnmanagedShutdown() {
  return {
    reserveStartup: vi.fn((_createdAt, _policy, persist) => persist()),
    markRecoveryInvoked: vi.fn(),
    recordProviderStartup: vi.fn<SandboxShutdownLifecycle["recordProviderStartup"]>(async () => {}),
    isHolding: vi.fn(() => false),
    requestShutdown: vi.fn<SandboxShutdownLifecycle["requestShutdown"]>(async () => "unmanaged"),
    captureCheckpoint: vi.fn<SandboxShutdownLifecycle["captureCheckpoint"]>(async () => ({
      outcome: "saved",
      imageId: "snapshot-img-123",
      sourceStopped: false,
    })),
    startupDecision: vi.fn<SandboxShutdownLifecycle["startupDecision"]>(() => ({
      kind: "normal",
    })),
    holdFailedRecovery: vi.fn(),
    runtimeReady: vi.fn(),
    generationReady: vi.fn(),
    prepared: vi.fn(),
    admissionDecision: vi.fn(() => "unmanaged" as const),
    handleAlarm: vi.fn(async () => "continue" as const),
    recover: vi.fn(async () => undefined),
    snapshot: vi.fn(() => null),
  } satisfies SandboxShutdownLifecycle;
}

export function createCheckpointShutdown(
  provider: SandboxProvider,
  storage: SandboxStorage & SessionContextReader,
  messenger: SandboxBroadcaster,
  onLifecycleChange: () => Promise<void> = async () => {},
  retireAccess: () => void = () => {}
): SandboxShutdownLifecycle {
  let state: ShutdownRecord | null = null;
  const coordinator = new SandboxShutdownCoordinator({
    store: {
      read: () => (state ? structuredClone(state) : null),
      write: (next: ShutdownRecord) => {
        state = structuredClone(next);
      },
    },
    provider,
    sandbox: storage,
    session: {
      getSession: () => storage.getSession(),
      transaction: <T>(operation: () => T): T => operation(),
    },
    messages: { getProcessingMessage: () => null },
    failures: { record: vi.fn(), deliver: vi.fn() },
    messenger,
    sockets: { getSandboxSocket: () => null },
    alarm: createMockAlarmScheduler(),
    background: { submit: vi.fn((task: () => Promise<void>) => void task()) },
    onLifecycleChange: vi.fn(onLifecycleChange),
    reconcileStatusFromMessages: vi.fn(async () => {}),
    retireAccess,
  } as never);
  return {
    ...createUnmanagedShutdown(),
    captureCheckpoint: (generation, reason) => coordinator.captureCheckpoint(generation, reason),
    requestShutdown: (reason, mode) =>
      mode === "emergency"
        ? coordinator.requestShutdown(reason, mode)
        : Promise.resolve("unmanaged"),
    isHolding: () => coordinator.isHolding(),
    admissionDecision: () => coordinator.admissionDecision(),
  };
}

export function createAlarmFixture(
  sandbox: ReturnType<typeof createMockSandbox> | null,
  provider = createMockProvider(),
  clientCount = 0,
  onLifecycleChange: () => Promise<void> = async () => {}
) {
  const storage = createMockStorage(createMockSession(), sandbox);
  const broadcaster = createMockBroadcaster();
  const wsManager = createMockWebSocketManager(false, clientCount);
  const alarmScheduler = createMockAlarmScheduler();
  const shutdown = createCheckpointShutdown(provider, storage, broadcaster, onLifecycleChange);
  const manager = new SandboxLifecycleManager(
    provider,
    storage,
    storage,
    broadcaster,
    wsManager,
    alarmScheduler,
    createMockIdGenerator(),
    shutdown,
    createTestConfig()
  );
  return { manager, storage, broadcaster, wsManager, alarmScheduler, provider, shutdown };
}
