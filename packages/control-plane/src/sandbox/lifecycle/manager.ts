/**
 * SandboxLifecycleManager - orchestrates sandbox lifecycle operations.
 *
 * This class coordinates spawn, restore, snapshot, and timeout logic by:
 * 1. Using pure decision functions to make decisions (no side effects)
 * 2. Executing side effects through injected dependencies (storage, broadcast, etc.)
 * 3. Delegating provider operations to the SandboxProvider abstraction
 *
 * The manager owns the in-memory `isSpawningSandbox` flag to prevent concurrent
 * spawn attempts within the same request.
 */

import {
  extractProviderAndModel,
  type McpServerConfig,
  type SandboxSettings,
} from "@open-inspect/shared";
import type { SandboxStatus } from "../../types";
import { sessionHasRepository, type SandboxRow, type SessionRow } from "../../session/types";
import {
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SessionRepositoryInfo,
} from "../provider";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateConnectingTimeout,
  evaluateWarmDecision,
  isDeadSandboxStatus,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  type CircuitBreakerConfig,
  type SpawnConfig,
  type InactivityConfig,
  type HeartbeatConfig,
  type ConnectingTimeoutConfig,
} from "./decisions";
import { createLogger, type Logger } from "../../logger";
import { hashToken } from "../../auth/crypto";
import { mintJwt } from "../../auth/jwt";
import { repoImageBuildScope, type ImageBuildScope } from "../../image-builds/model";
import { normalizeSandboxSettings } from "../settings";
import {
  evaluateImageBuildForSpawn,
  type ImageBuildLookup,
  type SelectedImageBuild,
} from "./image-selection";

export type { ImageBuildLookup } from "./image-selection";

const log = createLogger("lifecycle-manager");

/** TTL for terminal auth JWTs (24 hours, matching typical sandbox lifetime). */
const TERMINAL_TOKEN_TTL_SECONDS = 86400;

// ==================== Dependency Interfaces ====================

/**
 * Sandbox state with circuit breaker info (subset of full SandboxRow).
 */
export interface SandboxCircuitBreakerInfo {
  status: string;
  created_at: number;
  modal_object_id: string | null;
  snapshot_image_id: string | null;
  spawn_failure_count: number | null;
  last_spawn_failure: number | null;
}

/**
 * Storage adapter for sandbox data operations.
 */
export interface SandboxStorage {
  /** Get current sandbox state */
  getSandbox(): SandboxRow | null;
  /** Get sandbox with circuit breaker state (subset of fields) */
  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerInfo | null;
  /** Get current session */
  getSession(): SessionRow | null;
  /**
   * Get the session's member repositories in position order. Pre-list
   * sessions get a one-entry list synthesized from the scalar columns
   * (buildSessionRepositories owns the rule); empty only for repo-less
   * sessions.
   */
  getSessionRepositories(): SessionRepositoryInfo[];
  /** Get user env vars for sandbox injection */
  getUserEnvVars(): Promise<Record<string, string> | undefined>;
  /** Update sandbox status */
  updateSandboxStatus(status: SandboxStatus): void;
  /** Update sandbox for spawn (status, auth token, sandbox ID, created_at) */
  updateSandboxForSpawn(data: {
    status: SandboxStatus;
    createdAt: number;
    authTokenHash: string;
    modalSandboxId: string;
  }): void;
  /** Update sandbox state for in-place resume without rotating auth/token identity */
  updateSandboxForResume?(data: { status: SandboxStatus; createdAt: number }): void;
  /** Update sandbox Modal object ID (for snapshot API) */
  updateSandboxModalObjectId(modalObjectId: string): void;
  /** Update sandbox snapshot image ID */
  updateSandboxSnapshotImageId(sandboxId: string, imageId: string): void;
  /** Update last activity timestamp */
  updateSandboxLastActivity(timestamp: number): void;
  /** Increment circuit breaker failure count */
  incrementCircuitBreakerFailure(timestamp: number): void;
  /** Reset circuit breaker failure count */
  resetCircuitBreaker(): void;
  /** Persist last spawn error */
  setLastSpawnError(error: string | null, timestamp: number | null): void;
  /** Update code-server URL and (encrypted) password on the sandbox row */
  updateSandboxCodeServer(url: string, password: string): void | Promise<void>;
  /** Clear stale code-server URL and password (e.g. on sandbox teardown) */
  clearSandboxCodeServer(): void;
  /** Clear the code-server URL while preserving the stored password */
  clearSandboxCodeServerUrl?(): void;
  /** Update tunnel URLs for extra ports on the sandbox row */
  updateSandboxTunnelUrls(urls: Record<string, string>): void | Promise<void>;
  /** Clear stale tunnel URLs (e.g. on sandbox teardown) */
  clearSandboxTunnelUrls(): void;
  /** Update ttyd proxy URL and (encrypted) JWT token on the sandbox row */
  updateSandboxTtyd(url: string, token: string): void | Promise<void>;
  /** Clear stale ttyd URL and token (e.g. on sandbox teardown) */
  clearSandboxTtyd(): void;
}

/**
 * Broadcaster for sending messages to connected clients.
 */
export interface SandboxBroadcaster {
  /** Broadcast a message to all connected clients */
  broadcast(message: object): void;
}

/**
 * WebSocket manager for sandbox communication.
 */
export interface WebSocketManager {
  /** Get the sandbox WebSocket (with hibernation recovery) */
  getSandboxWebSocket(): WebSocket | null;
  /** Close the sandbox WebSocket */
  closeSandboxWebSocket(code: number, reason: string): void;
  /** Send a message to the sandbox */
  sendToSandbox(message: object): boolean;
  /** Get count of connected client WebSockets (excludes sandbox) */
  getConnectedClientCount(): number;
}

/**
 * Alarm scheduler for timeouts.
 */
export interface AlarmScheduler {
  /** Schedule an alarm at the given timestamp */
  scheduleAlarm(timestamp: number): Promise<void>;
}

/**
 * ID generator for sandbox and token IDs.
 */
export interface IdGenerator {
  /** Generate a unique ID */
  generateId(): string;
}

// ==================== Configuration ====================

/**
 * Complete lifecycle configuration.
 */
export interface SandboxLifecycleConfig {
  circuitBreaker: CircuitBreakerConfig;
  spawn: SpawnConfig;
  inactivity: InactivityConfig;
  heartbeat: HeartbeatConfig;
  connectingTimeout: ConnectingTimeoutConfig;
  controlPlaneUrl: string;
  /** Default model ID used when the session has no model override. */
  model: string;
  /** Session ID for log correlation. Optional — logs will omit sessionId if not provided. */
  sessionId?: string;
  /** MCP server lookup for injecting servers into sandboxes. */
  mcpServerLookup?: McpServerLookup;
  /** Resolves the spawn-time agent-slack-notify gate. */
  slackAgentNotifyLookup?: SlackAgentNotifyLookup;
  /** Builds a provider dashboard URL for a persisted provider object ID. */
  sandboxDashboardUrlBuilder?: (providerObjectId: string) => string | null;
}

/**
 * Default lifecycle configuration.
 */
export const DEFAULT_LIFECYCLE_CONFIG: Omit<SandboxLifecycleConfig, "controlPlaneUrl" | "model"> = {
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  spawn: DEFAULT_SPAWN_CONFIG,
  inactivity: DEFAULT_INACTIVITY_CONFIG,
  heartbeat: DEFAULT_HEARTBEAT_CONFIG,
  connectingTimeout: DEFAULT_CONNECTING_TIMEOUT_CONFIG,
};

/** Child (agent-spawned) sessions get a shorter sandbox timeout. */
const CHILD_SANDBOX_TIMEOUT_SECONDS = 3600; // 1 hour (vs default 2 hours)

function buildSandboxIdForSession(session: SessionRow, now: number): string {
  const sandboxName = sessionHasRepository(session)
    ? `${session.repo_owner}-${session.repo_name}`
    : session.id;
  return `sandbox-${sandboxName}-${now}`;
}

/**
 * Multi-repo additions to a spawn/restore config. Single-repo sessions keep
 * the scalar wire form untouched (the runtime synthesizes its one-entry
 * list from repo_owner/repo_name/branch), so nothing changes for them.
 * Working-branch names stay lazily derived at PR-creation time
 * (pull-request-service) and reach the sandbox via per-repo push specs,
 * never via spawn config.
 */
function multiRepoSpawnFields(
  repositories: SessionRepositoryInfo[]
): Pick<CreateSandboxConfig, "repositories"> {
  return repositories.length > 1 ? { repositories } : {};
}

// ==================== MCP Server Lookup ====================

/**
 * Lookup interface for MCP servers applicable to a session.
 * Keeps the lifecycle manager free of direct D1Database dependencies.
 * Receives the session's member repositories (empty for repo-less sessions);
 * a scoped server applies when any member matches one of its scopes.
 */
export interface McpServerLookup {
  getDecryptedForSession(
    repositories: Array<{ repoOwner: string; repoName: string }>
  ): Promise<McpServerConfig[]>;
}

// ==================== Slack Agent-Notify Lookup ====================

/**
 * Resolves the spawn-time agent-slack-notify gate for a repository or the
 * global no-repository scope.
 * False (or throwing) means do not install the tool in this sandbox.
 */
export interface SlackAgentNotifyLookup {
  isEnabledForRepo(repoOwner: string | null, repoName: string | null): Promise<boolean>;
}

// ==================== Callbacks ====================

/**
 * Optional callbacks from the lifecycle manager to the session DO.
 * Lightweight callback interface — the manager doesn't know what the callbacks do.
 */
export interface LifecycleCallbacks {
  /** Called when the sandbox is being terminated (heartbeat stale, inactivity timeout). */
  onSandboxTerminating?: () => Promise<void>;
  /** Whether a message is currently executing (gates disruptive maintenance like runtime-cap cycling). */
  getIsProcessing?: () => boolean;
  /** Tie a detached best-effort promise to the DO request lifetime (ctx.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

// ==================== Manager ====================

/**
 * Manages sandbox lifecycle operations.
 *
 * Uses dependency injection for all external interactions, enabling unit testing
 * with mocked dependencies.
 */
export class SandboxLifecycleManager {
  /**
   * In-memory flag to prevent concurrent spawn attempts within the same request.
   * This is NOT persisted - it protects against multiple spawns in one DO method call.
   * The persisted sandbox status ("spawning", "connecting") handles cross-request protection.
   */
  private isSpawningSandbox = false;

  /** Session-scoped logger. Falls back to module-level logger if no sessionId configured. */
  private readonly log: Logger;

  constructor(
    private readonly provider: SandboxProvider,
    private readonly storage: SandboxStorage,
    private readonly broadcaster: SandboxBroadcaster,
    private readonly wsManager: WebSocketManager,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly idGenerator: IdGenerator,
    private readonly config: SandboxLifecycleConfig,
    private readonly callbacks: LifecycleCallbacks = {},
    private readonly imageBuildLookup?: ImageBuildLookup
  ) {
    this.log = config.sessionId ? log.child({ session_id: config.sessionId }) : log;
  }

  /**
   * Spawn a sandbox (fresh or from snapshot).
   *
   * Uses decision functions to determine the appropriate action:
   * - Check circuit breaker
   * - Restore from snapshot if available and sandbox is stopped/stale/failed
   * - Fresh spawn if all conditions pass
   */
  async spawnSandbox(): Promise<void> {
    const sandboxState = this.storage.getSandboxWithCircuitBreaker();
    const now = Date.now();

    // Extract circuit breaker state
    const circuitBreakerState = {
      failureCount: sandboxState?.spawn_failure_count || 0,
      lastFailureTime: sandboxState?.last_spawn_failure || 0,
    };

    // Check circuit breaker
    const cbDecision = evaluateCircuitBreaker(circuitBreakerState, this.config.circuitBreaker, now);

    if (cbDecision.shouldReset) {
      this.log.info("Circuit breaker reset");
      this.storage.resetCircuitBreaker();
    }

    if (!cbDecision.shouldProceed) {
      this.log.warn("Circuit breaker open", {
        event: "sandbox.circuit_breaker_open",
        failure_count: circuitBreakerState.failureCount,
        wait_time_ms: cbDecision.waitTimeMs || 0,
      });
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: `Sandbox spawning temporarily disabled after ${circuitBreakerState.failureCount} failures. Try again in ${Math.ceil((cbDecision.waitTimeMs || 0) / 1000)} seconds.`,
      });
      return;
    }

    // Evaluate spawn decision
    const spawnState = {
      status: (sandboxState?.status || "pending") as SandboxStatus,
      createdAt: sandboxState?.created_at || 0,
      providerObjectId: sandboxState?.modal_object_id || null,
      snapshotImageId: sandboxState?.snapshot_image_id || null,
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
    };

    const spawnDecision = evaluateSpawnDecision(
      spawnState,
      this.config.spawn,
      now,
      this.isSpawningSandbox,
      !!this.provider.capabilities.supportsPersistentResume
    );

    switch (spawnDecision.action) {
      case "skip":
        this.log.info("Spawn decision: skip", {
          reason: spawnDecision.reason,
          sandbox_status: spawnState.status,
        });
        return;

      case "wait":
        this.log.info("Spawn decision: wait", {
          reason: spawnDecision.reason,
          sandbox_status: spawnState.status,
        });
        return;

      case "restore":
        this.log.info("Spawn decision: restore", {
          snapshot_image_id: spawnDecision.snapshotImageId,
        });
        await this.restoreFromSnapshot(spawnDecision.snapshotImageId);
        return;

      case "resume":
        this.log.info("Spawn decision: resume", {
          provider_object_id: spawnDecision.providerObjectId,
        });
        await this.resumeSandbox(spawnDecision.providerObjectId);
        return;

      case "spawn":
        await this.doSpawn();
        return;
    }
  }

  /**
   * Execute a fresh sandbox spawn.
   */
  private async doSpawn(): Promise<void> {
    this.isSpawningSandbox = true;

    try {
      const session = this.storage.getSession();
      if (!session) {
        this.log.error("Cannot spawn sandbox: no session");
        return;
      }

      this.storage.setLastSpawnError(null, null);

      const now = Date.now();
      const sessionId = session.session_name || session.id;
      let sandboxAuthToken = this.idGenerator.generateId();
      const hasRepository = sessionHasRepository(session);
      let expectedSandboxId = buildSandboxIdForSession(session, now);

      // Store expected sandbox ID and auth token BEFORE calling provider
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt: now,
        authTokenHash: await hashToken(sandboxAuthToken),
        modalSandboxId: expectedSandboxId,
      });
      this.broadcaster.broadcast({ type: "sandbox_status", status: "spawning" });

      this.log.info("Spawning sandbox", {
        event: "sandbox.spawn",
        expected_sandbox_id: expectedSandboxId,
        repo_owner: session.repo_owner,
        repo_name: session.repo_name,
      });

      const userEnvVars = await this.storage.getUserEnvVars();
      const { provider, model: modelId } = this.resolveProviderAndModel(session);
      const repositories = this.storage.getSessionRepositories();
      const multiRepoFields = multiRepoSpawnFields(repositories);

      // Prebuilt-image selection: an environment session matches its
      // environment's image against the session's own repository snapshot
      // (design §7.3); a single-repo ad-hoc session matches its repo scope's
      // image the same way, where the one-element fingerprint reproduces the
      // old base_branch filter (non-default-branch sessions miss to base).
      // Environment sessions never fall back to a repo image — it bakes that
      // repository's setup and secrets, not the environment's — and
      // multi-repo ad-hoc sessions never use prebuilt images (a repo image
      // bakes a single checkout), so both miss straight to the base image.
      let selectedImage: SelectedImageBuild | null = null;
      if (session.environment_id) {
        selectedImage = await this.lookupImageBuildForSpawn(
          { kind: "environment", id: session.environment_id },
          repositories
        );
      } else if (hasRepository && repositories.length === 1) {
        selectedImage = await this.lookupImageBuildForSpawn(
          repoImageBuildScope(repositories[0].repoOwner, repositories[0].repoName),
          repositories
        );
      }

      const prebuiltImageId: string | null = selectedImage?.providerImageId ?? null;
      const prebuiltImageSha: string | null = selectedImage?.primaryBaseSha ?? null;

      // Child sessions get a shorter timeout
      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      const mcpServers = await this.loadMcpServers(repositories);

      const codeServerEnabled = session.code_server_enabled === 1;
      const agentSlackNotifyEnabled = await this.resolveAgentSlackNotifyEnabled(session);
      const sandboxSettings = this.parseSandboxSettings(session);
      const createConfig: CreateSandboxConfig = {
        sessionId,
        sandboxId: expectedSandboxId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        controlPlaneUrl: this.config.controlPlaneUrl,
        sandboxAuthToken,
        provider,
        model: modelId,
        userEnvVars,
        prebuiltImageId,
        prebuiltImageSha,
        timeoutSeconds,
        branch: session.base_branch,
        codeServerEnabled,
        agentSlackNotifyEnabled,
        mcpServers,
        sandboxSettings,
        ...multiRepoFields,
      };

      let result: CreateSandboxResult;
      try {
        result = await this.provider.createSandbox(createConfig);
      } catch (error) {
        if (!selectedImage) throw error;
        // A provider restore failure is "no image" (design §7.3): fail the
        // row so the cron rebuilds it and boot this session from base rather
        // than failing the spawn. Unrelated create failures (quota, network)
        // can false-positive here — the cost is one rebuild, and the base
        // retry surfaces them through the normal failure path anyway.
        this.log.warn("Prebuilt-image spawn failed, retrying from base image", {
          event: "image_build.restore_failed",
          image_build_id: selectedImage.imageBuildId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.markImageBuildRestoreFailed(selectedImage, error);
        // The retry gets a fresh spawn identity: the failed attempt may have
        // actually created a sandbox provider-side (post-create errors are
        // indistinguishable here), and rotating the token hash and sandbox id
        // locks such an orphan out of this DO exactly like the next
        // user-initiated respawn would.
        const retryNow = Math.max(Date.now(), now + 1);
        sandboxAuthToken = this.idGenerator.generateId();
        expectedSandboxId = buildSandboxIdForSession(session, retryNow);
        this.storage.updateSandboxForSpawn({
          status: "spawning",
          createdAt: retryNow,
          authTokenHash: await hashToken(sandboxAuthToken),
          modalSandboxId: expectedSandboxId,
        });
        result = await this.provider.createSandbox({
          ...createConfig,
          sandboxId: expectedSandboxId,
          sandboxAuthToken,
          prebuiltImageId: null,
          prebuiltImageSha: null,
        });
      }

      this.log.info("Sandbox spawned", {
        event: "sandbox.spawned",
        sandbox_id: result.sandboxId,
        provider_object_id: result.providerObjectId,
      });

      if (result.providerObjectId) {
        this.storeAndBroadcastProviderObjectId(result.providerObjectId);
      }
      if (result.codeServerUrl && result.codeServerPassword) {
        await this.storeAndBroadcastCodeServer(result.codeServerUrl, result.codeServerPassword);
      }
      await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
      if (result.ttydUrl) {
        await this.storeAndBroadcastTtyd(
          result.ttydUrl,
          sandboxAuthToken,
          sessionId,
          expectedSandboxId
        );
      }

      this.storage.updateSandboxStatus("connecting");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

      // Schedule connecting timeout watchdog — if the bridge doesn't connect
      // within the allowed window, handleAlarm() will fail the sandbox.
      // This alarm is naturally replaced by the inactivity alarm on successful connect.
      await this.alarmScheduler.scheduleAlarm(Date.now() + this.config.connectingTimeout.timeoutMs);

      // Reset circuit breaker on successful spawn initiation
      this.storage.resetCircuitBreaker();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to spawn sandbox";
      this.storage.setLastSpawnError(errorMessage, Date.now());
      this.log.error("Sandbox spawn failed", {
        event: "sandbox.spawn_failed",
        error: error instanceof Error ? error : String(error),
      });

      // Only increment circuit breaker for permanent errors
      if (error instanceof SandboxProviderError) {
        if (error.errorType === "permanent") {
          this.storage.incrementCircuitBreakerFailure(Date.now());
          this.log.info("Circuit breaker incremented", { error_type: "permanent" });
        } else {
          this.log.info("Transient error, not incrementing circuit breaker", {
            error_type: error.errorType,
          });
        }
      } else {
        // Unknown error type - treat as permanent
        this.storage.incrementCircuitBreakerFailure(Date.now());
        this.log.info("Circuit breaker incremented", { error_type: "unknown" });
      }

      this.storage.updateSandboxStatus("failed");
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: errorMessage,
      });
    } finally {
      this.isSpawningSandbox = false;
    }
  }

  /**
   * Resolve the scope's prebuilt image for a fresh spawn. Returns null on any
   * miss or lookup failure — the session boots from base (never blocked,
   * design §7.3) — logging the reason either way; miss-reason counts are the
   * numbers that justify (or kill) the prebuild fast-follows.
   */
  private async lookupImageBuildForSpawn(
    scope: ImageBuildScope,
    repositories: SessionRepositoryInfo[]
  ): Promise<SelectedImageBuild | null> {
    if (!this.imageBuildLookup || repositories.length === 0) return null;
    try {
      const image = await this.imageBuildLookup.getLatestReady(scope);
      const result = await evaluateImageBuildForSpawn(image, repositories);
      if (result.outcome === "selected") {
        this.log.info("Using prebuilt image", {
          event: "image_build.spawn_selected",
          scope_kind: scope.kind,
          scope_id: scope.id,
          image_build_id: result.image.imageBuildId,
          runtime_version: result.image.runtimeVersion,
        });
        return result.image;
      }
      this.log.info("Prebuilt image miss, using base image", {
        event: "image_build.spawn_miss",
        scope_kind: scope.kind,
        scope_id: scope.id,
        reason: result.reason,
        image_build_id: result.imageBuildId,
      });
      return null;
    } catch (e) {
      this.log.warn("Failed to look up prebuilt image, using base image", {
        event: "image_build.spawn_miss",
        scope_kind: scope.kind,
        scope_id: scope.id,
        reason: "lookup_failed",
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Best-effort: the base-image retry must proceed even when D1 is the thing
   * that is down. An unmarked row costs one more failed image boot on the
   * next spawn, not a broken session.
   */
  private async markImageBuildRestoreFailed(
    image: SelectedImageBuild,
    error: unknown
  ): Promise<void> {
    if (!this.imageBuildLookup) return;
    try {
      await this.imageBuildLookup.markRestoreFailed(
        image.imageBuildId,
        `restore failed at spawn: ${error instanceof Error ? error.message : String(error)}`
      );
    } catch (e) {
      this.log.warn("Failed to mark prebuilt image restore-failed", {
        image_build_id: image.imageBuildId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async resolveAgentSlackNotifyEnabled(session: SessionRow): Promise<boolean> {
    if (!this.config.slackAgentNotifyLookup) return false;
    try {
      return await this.config.slackAgentNotifyLookup.isEnabledForRepo(
        sessionHasRepository(session) ? session.repo_owner : null,
        sessionHasRepository(session) ? session.repo_name : null
      );
    } catch (err) {
      this.log.warn("Failed to resolve agent slack-notify gate; treating as disabled", {
        event: "slack_notify.gate_resolve_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Load MCP servers applicable to the current session's repository.
   * Returns undefined if none are found or DB is not configured.
   */
  private async loadMcpServers(
    repositories: SessionRepositoryInfo[]
  ): Promise<McpServerConfig[] | undefined> {
    try {
      if (!this.config.mcpServerLookup) return undefined;
      const servers = await this.config.mcpServerLookup.getDecryptedForSession(
        repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
      );
      this.log.info("MCP servers loaded", {
        event: "mcp.loaded",
        count: servers?.length ?? 0,
        names: servers?.map((s) => s.name) ?? [],
      });
      return servers?.length ? servers : undefined;
    } catch (err) {
      this.log.warn("Failed to load MCP servers", {
        event: "mcp.load_failed",
        error: String(err),
      });
      return undefined;
    }
  }

  /**
   * Restore a sandbox from a filesystem snapshot.
   */
  private async restoreFromSnapshot(snapshotImageId: string): Promise<void> {
    if (!this.provider.restoreFromSnapshot) {
      this.log.info("Provider does not support restore, falling back to fresh spawn");
      // Fall back to fresh spawn
      await this.doSpawn();
      return;
    }

    this.isSpawningSandbox = true;

    try {
      const session = this.storage.getSession();
      if (!session) {
        this.log.error("Cannot restore: no session");
        return;
      }

      this.storage.setLastSpawnError(null, null);

      const now = Date.now();
      const sandboxAuthToken = this.idGenerator.generateId();
      const sandboxAuthTokenHash = await hashToken(sandboxAuthToken);
      const expectedSandboxId = buildSandboxIdForSession(session, now);

      // Store expected sandbox ID and auth token
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt: now,
        authTokenHash: sandboxAuthTokenHash,
        modalSandboxId: expectedSandboxId,
      });
      this.broadcaster.broadcast({ type: "sandbox_status", status: "spawning" });

      this.log.info("Restoring from snapshot", {
        event: "sandbox.restore",
        snapshot_image_id: snapshotImageId,
      });

      const userEnvVars = await this.storage.getUserEnvVars();
      const { provider, model: modelId } = this.resolveProviderAndModel(session);

      // Child sessions get a shorter timeout (same logic as doSpawn)
      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      const repositories = this.storage.getSessionRepositories();
      const codeServerEnabled = session.code_server_enabled === 1;
      const agentSlackNotifyEnabled = await this.resolveAgentSlackNotifyEnabled(session);
      const mcpServers = await this.loadMcpServers(repositories);
      const sandboxSettings = this.parseSandboxSettings(session);
      const result = await this.provider.restoreFromSnapshot({
        snapshotImageId,
        sessionId: session.session_name || session.id,
        sandboxId: expectedSandboxId,
        sandboxAuthToken,
        controlPlaneUrl: this.config.controlPlaneUrl,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        provider,
        model: modelId,
        userEnvVars,
        timeoutSeconds,
        branch: session.base_branch,
        codeServerEnabled,
        agentSlackNotifyEnabled,
        mcpServers,
        sandboxSettings,
        ...multiRepoSpawnFields(repositories),
      });

      if (result.success) {
        this.log.info("Sandbox restored", {
          event: "sandbox.restored",
          sandbox_id: result.sandboxId,
          provider_object_id: result.providerObjectId,
        });

        if (result.providerObjectId) {
          this.storeAndBroadcastProviderObjectId(result.providerObjectId);
        }
        if (result.codeServerUrl && result.codeServerPassword) {
          await this.storeAndBroadcastCodeServer(result.codeServerUrl, result.codeServerPassword);
        }
        await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
        if (result.ttydUrl) {
          await this.storeAndBroadcastTtyd(
            result.ttydUrl,
            sandboxAuthToken,
            session.session_name || session.id,
            expectedSandboxId
          );
        }

        this.storage.updateSandboxStatus("connecting");
        this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

        // Schedule connecting timeout watchdog
        await this.alarmScheduler.scheduleAlarm(
          Date.now() + this.config.connectingTimeout.timeoutMs
        );

        this.broadcaster.broadcast({
          type: "sandbox_restored",
          message: "Session restored from snapshot",
        });
      } else {
        this.log.error("Snapshot restore failed", {
          error: result.error,
          snapshot_image_id: snapshotImageId,
        });
        this.storage.setLastSpawnError(
          result.error || "Failed to restore from snapshot",
          Date.now()
        );
        this.storage.updateSandboxStatus("failed");
        this.broadcaster.broadcast({
          type: "sandbox_error",
          error: result.error || "Failed to restore from snapshot",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to restore sandbox";
      this.storage.setLastSpawnError(errorMessage, Date.now());
      this.log.error("Snapshot restore request failed", {
        error: error instanceof Error ? error : String(error),
        snapshot_image_id: snapshotImageId,
      });
      this.storage.updateSandboxStatus("failed");
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: errorMessage,
      });
    } finally {
      this.isSpawningSandbox = false;
    }
  }

  /**
   * Resume a provider-managed sandbox in place without rotating the logical sandbox ID.
   */
  private async resumeSandbox(providerObjectId: string): Promise<void> {
    if (!this.provider.resumeSandbox) {
      await this.doSpawn();
      return;
    }

    this.isSpawningSandbox = true;

    try {
      const session = this.storage.getSession();
      const sandbox = this.storage.getSandbox();
      if (!session || !sandbox?.modal_sandbox_id) {
        this.log.error("Cannot resume sandbox: missing session or logical sandbox ID");
        return;
      }

      const now = Date.now();
      this.storage.setLastSpawnError(null, null);
      this.storage.updateSandboxForResume?.({
        status: "connecting",
        createdAt: now,
      });
      if (!this.storage.updateSandboxForResume) {
        this.storage.updateSandboxStatus("connecting");
      }
      this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      const result = await this.provider.resumeSandbox({
        providerObjectId,
        sessionId: session.session_name || session.id,
        sandboxId: sandbox.modal_sandbox_id,
        timeoutSeconds,
        codeServerEnabled: session.code_server_enabled === 1,
        sandboxSettings: this.parseSandboxSettings(session),
      });

      if (!result.success) {
        if (result.shouldSpawnFresh) {
          this.log.info("Resume fell back to fresh spawn", {
            provider_object_id: providerObjectId,
            error: result.error,
          });
          await this.doSpawn();
          return;
        }

        throw new Error(result.error || "Failed to resume sandbox");
      }

      const finalProviderObjectId = result.providerObjectId ?? providerObjectId;
      if (result.providerObjectId && result.providerObjectId !== providerObjectId) {
        this.storeProviderObjectId(result.providerObjectId);
      }
      this.broadcastSandboxDashboardUrl(finalProviderObjectId);

      if (result.codeServerUrl && result.codeServerPassword) {
        await this.storeAndBroadcastCodeServer(result.codeServerUrl, result.codeServerPassword);
      }

      await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
      await this.alarmScheduler.scheduleAlarm(Date.now() + this.config.connectingTimeout.timeoutMs);
      this.storage.resetCircuitBreaker();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to resume sandbox";
      this.storage.setLastSpawnError(errorMessage, Date.now());
      this.storage.updateSandboxStatus("failed");
      // The sandbox may be paused/unreachable — don't leave clients holding
      // dead code-server/tunnel URLs (matches the other failure paths).
      this.clearSandboxAccessState();
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: errorMessage,
      });
      this.log.error("Sandbox resume failed", {
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      this.isSpawningSandbox = false;
    }
  }

  /**
   * Trigger a filesystem snapshot of the sandbox.
   */
  async triggerSnapshot(reason: string): Promise<void> {
    if (!this.provider.takeSnapshot) {
      this.log.debug("Provider does not support snapshots");
      return;
    }

    const sandbox = this.storage.getSandbox();
    const session = this.storage.getSession();

    if (!sandbox?.modal_object_id || !session) {
      this.log.debug("Cannot snapshot: no modal_object_id or session");
      return;
    }

    // Don't snapshot if already snapshotting
    if (sandbox.status === "snapshotting") {
      this.log.debug("Already snapshotting, skipping");
      return;
    }

    // Track previous status for non-terminal states
    const isTerminalState = isDeadSandboxStatus(sandbox.status);
    const previousStatus = sandbox.status;

    if (!isTerminalState) {
      this.storage.updateSandboxStatus("snapshotting");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "snapshotting" });
    }

    try {
      this.log.info("Taking snapshot", {
        event: "sandbox.snapshot",
        reason,
        modal_object_id: sandbox.modal_object_id,
      });

      const result = await this.provider.takeSnapshot({
        providerObjectId: sandbox.modal_object_id,
        sessionId: session.session_name || session.id,
        reason,
      });

      if (result.success && result.imageId) {
        this.storage.updateSandboxSnapshotImageId(sandbox.id, result.imageId);
        this.log.info("Snapshot saved", {
          event: "sandbox.snapshot_saved",
          image_id: result.imageId,
          reason,
        });
        this.broadcaster.broadcast({
          type: "snapshot_saved",
          imageId: result.imageId,
          reason,
        });
      } else {
        this.log.error("Snapshot failed", { error: result.error, reason });
      }
    } catch (error) {
      this.log.error("Snapshot request failed", {
        error: error instanceof Error ? error : String(error),
        reason,
      });
    }

    // Restore previous status if we weren't in a terminal state
    if (!isTerminalState && reason !== "heartbeat_timeout") {
      this.storage.updateSandboxStatus(previousStatus as SandboxStatus);
      this.broadcaster.broadcast({ type: "sandbox_status", status: previousStatus });
    }
  }

  /**
   * Whether the active provider can stop a sandbox via its API.
   */
  private canStopProviderSandbox(): boolean {
    return !!this.provider.capabilities.supportsExplicitStop && !!this.provider.stopSandbox;
  }

  /**
   * Whether stopping should preserve provider-owned state for in-place resume.
   */
  private usesProviderManagedStop(): boolean {
    return this.canStopProviderSandbox() && !!this.provider.capabilities.supportsPersistentResume;
  }

  /**
   * Clear preview URLs after a sandbox is no longer reachable.
   *
   * Daytona resumes preserve the code-server password, so only the URL is
   * cleared. Modal-style snapshots rotate the password on restore, so both
   * values are removed.
   */
  private clearSandboxAccessState(): void {
    if (this.usesProviderManagedStop() && this.storage.clearSandboxCodeServerUrl) {
      this.storage.clearSandboxCodeServerUrl();
      this.storage.clearSandboxTunnelUrls();
      this.storage.clearSandboxTtyd();
      return;
    }

    this.storage.clearSandboxCodeServer();
    this.storage.clearSandboxTunnelUrls();
    this.storage.clearSandboxTtyd();
  }

  /**
   * Stop a provider-managed sandbox via its API.
   */
  private async stopProviderSandbox(reason: string): Promise<void> {
    if (!this.provider.stopSandbox) {
      return;
    }

    const sandbox = this.storage.getSandbox();
    const session = this.storage.getSession();
    if (!sandbox?.modal_object_id || !session) {
      return;
    }

    const result = await this.provider.stopSandbox({
      providerObjectId: sandbox.modal_object_id,
      sessionId: session.session_name || session.id,
      reason,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to stop provider sandbox");
    }
  }

  /**
   * Pause a provider-managed sandbox so it can be resumed later, falling back to
   * a plain stop when the provider has no pause primitive.
   *
   * Used on the idle/heartbeat-stale paths where the sandbox is "freeable for
   * later" — providers like E2B pause (state preserved, resumable), while
   * Daytona (no pauseSandbox) falls through to its existing stop, which is
   * itself effectively a pause. Explicit-termination paths (connecting timeout,
   * operator/deployment shutdown) keep calling {@link stopProviderSandbox}.
   */
  private async pauseOrStopProviderSandbox(reason: string): Promise<void> {
    if (!this.provider.pauseSandbox) {
      await this.stopProviderSandbox(reason);
      return;
    }

    const sandbox = this.storage.getSandbox();
    const session = this.storage.getSession();
    if (!sandbox?.modal_object_id || !session) {
      return;
    }

    const result = await this.provider.pauseSandbox({
      providerObjectId: sandbox.modal_object_id,
      sessionId: session.session_name || session.id,
      reason,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to pause provider sandbox");
    }
  }

  /**
   * Handle alarm for inactivity and heartbeat monitoring.
   */
  async handleAlarm(): Promise<void> {
    const sandbox = this.storage.getSandbox();
    if (!sandbox) {
      this.log.debug("Alarm fired: no sandbox found");
      return;
    }

    const now = Date.now();

    this.log.debug("Alarm fired", {
      sandbox_status: sandbox.status,
      last_activity: sandbox.last_activity,
      last_heartbeat: sandbox.last_heartbeat,
    });

    // Skip if sandbox is already in terminal state
    if (isDeadSandboxStatus(sandbox.status)) {
      this.log.debug("Alarm: sandbox in terminal state, skipping", {
        sandbox_status: sandbox.status,
      });
      return;
    }

    // Check connecting timeout — sandbox failed to connect within allowed time
    const connectingResult = evaluateConnectingTimeout(
      sandbox.status as SandboxStatus,
      sandbox.created_at,
      this.config.connectingTimeout,
      now
    );

    if (connectingResult.isTimedOut) {
      this.log.warn("Connecting timeout", {
        event: "sandbox.connecting_timeout",
        elapsed_ms: connectingResult.elapsedMs,
        timeout_ms: this.config.connectingTimeout.timeoutMs,
      });
      await this.callbacks.onSandboxTerminating?.();
      this.storage.updateSandboxStatus("failed");
      this.clearSandboxAccessState();
      if (this.canStopProviderSandbox()) {
        try {
          await this.stopProviderSandbox("connecting_timeout");
        } catch (error) {
          this.log.warn("Provider stop failed after connecting timeout", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.broadcaster.broadcast({ type: "sandbox_status", status: "failed" });
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error:
          "Sandbox failed to connect within the allowed time. It will be retried on your next message.",
      });
      return;
    }

    // Check heartbeat health
    const heartbeatHealth = evaluateHeartbeatHealth(
      sandbox.last_heartbeat,
      this.config.heartbeat,
      now
    );

    if (heartbeatHealth.isStale) {
      this.log.warn("Heartbeat stale", {
        event: "sandbox.heartbeat_stale",
        last_heartbeat_ms: heartbeatHealth.ageMs || 0,
        threshold_ms: this.config.heartbeat.timeoutMs,
      });
      // Fail any stuck processing message before terminating
      await this.callbacks.onSandboxTerminating?.();
      this.storage.updateSandboxStatus("stale");
      this.clearSandboxAccessState();
      this.broadcaster.broadcast({ type: "sandbox_status", status: "stale" });

      if (this.usesProviderManagedStop()) {
        try {
          await this.pauseOrStopProviderSandbox("heartbeat_timeout");
        } catch (error) {
          this.log.warn("Provider pause failed after heartbeat timeout", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        if (this.canStopProviderSandbox()) {
          await this.triggerSnapshot("heartbeat_timeout");
          try {
            await this.stopProviderSandbox("heartbeat_timeout");
          } catch (error) {
            this.log.warn("Provider stop failed after heartbeat timeout", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Fire-and-forget snapshot so status broadcast isn't delayed.
          this.triggerSnapshot("heartbeat_timeout").catch((e) =>
            this.log.error("Heartbeat snapshot failed", {
              error: e instanceof Error ? e : String(e),
            })
          );
        }
        this.wsManager.sendToSandbox({ type: "shutdown" });
      }

      this.wsManager.closeSandboxWebSocket(1000, "Heartbeat stale");
      return;
    }

    // Evaluate inactivity timeout
    const connectedClients = this.getConnectedClientCount();
    const inactivityState = {
      lastActivity: sandbox.last_activity,
      status: sandbox.status as SandboxStatus,
      connectedClientCount: connectedClients,
    };

    const inactivityDecision = evaluateInactivityTimeout(
      inactivityState,
      this.config.inactivity,
      now
    );

    if (inactivityDecision.action === "timeout") {
      this.log.info("Inactivity timeout", {
        event: "sandbox.timeout",
        last_activity: sandbox.last_activity,
        timeout_ms: this.config.inactivity.timeoutMs,
      });
      // Fail any stuck processing message before terminating
      await this.callbacks.onSandboxTerminating?.();
      // Set status to stopped FIRST to block reconnection attempts
      this.storage.updateSandboxStatus("stopped");
      this.clearSandboxAccessState();
      this.broadcaster.broadcast({ type: "sandbox_status", status: "stopped" });

      if (this.usesProviderManagedStop()) {
        try {
          await this.pauseOrStopProviderSandbox("inactivity_timeout");
        } catch (error) {
          this.log.error("Provider pause failed after inactivity timeout", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        await this.triggerSnapshot("inactivity_timeout");
        this.wsManager.sendToSandbox({ type: "shutdown" });
        if (this.canStopProviderSandbox()) {
          try {
            await this.stopProviderSandbox("inactivity_timeout");
          } catch (error) {
            this.log.error("Provider stop failed after inactivity timeout", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      this.wsManager.closeSandboxWebSocket(1000, "Inactivity timeout");

      this.broadcaster.broadcast({
        type: "sandbox_warning",
        message: this.usesProviderManagedStop()
          ? "Sandbox stopped due to inactivity"
          : "Sandbox stopped due to inactivity, snapshot saved",
      });
      return;
    }

    // Continuous-runtime cap (e.g. E2B Hobby caps a sandbox at ~1h of running
    // time, unextendable via TTL refresh). Pause+resume cycles the sandbox to
    // reset the provider's runtime counter before it hard-kills, preserving
    // filesystem state and per-port hostnames. No-op for providers without a
    // runtime cap, which leave shouldResetRuntime undefined.
    //
    // Evaluated only AFTER the inactivity decision: an idle sandbox must pause
    // (above), never cycle — the post-resume bridge reconnect refreshes
    // last_activity, so cycling an idle sandbox would keep it alive (and
    // billable) indefinitely. Also skipped while a message is executing so an
    // active run isn't frozen mid-stream; the next alarm retries.
    if (
      this.provider.shouldResetRuntime &&
      sandbox.modal_object_id &&
      !this.callbacks.getIsProcessing?.()
    ) {
      const { shouldReset } = await this.provider.shouldResetRuntime({
        providerObjectId: sandbox.modal_object_id,
        startedAtMs: sandbox.created_at,
        nowMs: now,
      });
      if (shouldReset) {
        this.log.info("Runtime cap reset", {
          event: "sandbox.runtime_cap_reset",
          provider_object_id: sandbox.modal_object_id,
          elapsed_ms: now - sandbox.created_at,
        });
        try {
          // Pause then resume: resume() only resets the counter from a paused
          // state, and re-broadcasts tunnel/code-server state + resets created_at.
          await this.pauseOrStopProviderSandbox("runtime_cap_reset");
          await this.resumeSandbox(sandbox.modal_object_id);
        } catch (error) {
          // Best-effort: log and let the next alarm retry. If we pass the real
          // cap, the user's next message gets a fresh-spawn fallback.
          this.log.warn("Runtime cap reset failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Fall through to alarm scheduling: the chain must continue even if the
        // bridge fails to reconnect after the cycle.
      }
    }

    switch (inactivityDecision.action) {
      case "extend":
        this.log.info("Inactivity extended", {
          connected_clients: connectedClients,
          extension_ms: inactivityDecision.extensionMs,
        });
        if (inactivityDecision.shouldWarn) {
          this.broadcaster.broadcast({
            type: "sandbox_warning",
            message:
              "Sandbox will stop in 5 minutes due to inactivity. Send a message to keep it alive.",
          });
        }
        await this.alarmScheduler.scheduleAlarm(now + inactivityDecision.extensionMs);
        return;

      case "schedule":
        this.log.debug("Scheduling next alarm", { next_check_ms: inactivityDecision.nextCheckMs });
        await this.alarmScheduler.scheduleAlarm(now + inactivityDecision.nextCheckMs);
        return;
    }
  }

  /**
   * Warm sandbox proactively (e.g., when user starts typing).
   */
  async warmSandbox(): Promise<void> {
    const sandbox = this.storage.getSandbox();

    const warmState = {
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
      status: sandbox?.status as SandboxStatus | null,
      isSpawningInMemory: this.isSpawningSandbox,
    };

    const warmDecision = evaluateWarmDecision(warmState);

    if (warmDecision.action === "skip") {
      this.log.debug("Warm skipped", { reason: warmDecision.reason });
      return;
    }

    this.log.info("Warming sandbox");
    this.broadcaster.broadcast({ type: "sandbox_warming" });
    await this.spawnSandbox();
  }

  /**
   * Update last activity timestamp, and let the provider refresh sandbox TTLs.
   *
   * Synchronous by design: callers sit on hot event paths (every sandbox event,
   * prompt dispatch, WS connect), so only the storage write happens inline. The
   * optional provider TTL refresh is best-effort and runs detached — tied to the
   * DO request via callbacks.waitUntil so the runtime won't GC it mid-flight —
   * and never blocks message processing. Providers without onUserActivity
   * (Modal, Daytona) pay nothing beyond the method-presence check.
   */
  updateLastActivity(timestamp: number): void {
    this.storage.updateSandboxLastActivity(timestamp);

    if (!this.provider.onUserActivity) {
      return;
    }
    // refreshProviderActivity never rejects, so detaching is safe even when no
    // waitUntil callback is wired (tests, non-DO contexts).
    const refresh = this.refreshProviderActivity();
    this.callbacks.waitUntil?.(refresh);
  }

  /** Best-effort provider TTL refresh; swallows all errors. */
  private async refreshProviderActivity(): Promise<void> {
    const sandbox = this.storage.getSandbox();
    const session = this.storage.getSession();
    if (!sandbox?.modal_object_id || !session) {
      return;
    }
    try {
      await this.provider.onUserActivity!({
        providerObjectId: sandbox.modal_object_id,
        sessionId: session.session_name || session.id,
      });
    } catch (error) {
      // Best-effort: a transient TTL-refresh failure must not fail the user's
      // message. The provider throttles + logs internally.
      this.log.warn("Provider onUserActivity failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Schedule an inactivity check alarm.
   */
  async scheduleInactivityCheck(): Promise<void> {
    const alarmTime = Date.now() + this.config.inactivity.timeoutMs;
    this.log.debug("Scheduling inactivity check", { timeout_ms: this.config.inactivity.timeoutMs });
    await this.alarmScheduler.scheduleAlarm(alarmTime);
  }

  /**
   * Schedule a disconnect check alarm (heartbeat timeout from now).
   * Used after abnormal WebSocket close to ensure dead sandboxes are detected
   * promptly. If the bridge reconnects, scheduleInactivityCheck() will override
   * this alarm (Cloudflare DOs support only one alarm at a time).
   */
  async scheduleDisconnectCheck(): Promise<void> {
    const alarmTime = Date.now() + this.config.heartbeat.timeoutMs;
    this.log.debug("Scheduling disconnect check", { timeout_ms: this.config.heartbeat.timeoutMs });
    await this.alarmScheduler.scheduleAlarm(alarmTime);
  }

  /**
   * Resolve the provider and model ID from the session or config default.
   * e.g., "openai/gpt-5.3-codex" -> { provider: "openai", model: "gpt-5.3-codex" }
   */
  private resolveProviderAndModel(session: SessionRow): { provider: string; model: string } {
    return extractProviderAndModel(session.model || this.config.model);
  }

  /**
   * Get the count of connected client WebSockets.
   */
  private getConnectedClientCount(): number {
    return this.wsManager.getConnectedClientCount();
  }

  private storeAndBroadcastProviderObjectId(providerObjectId: string): void {
    this.storeProviderObjectId(providerObjectId);
    this.broadcastSandboxDashboardUrl(providerObjectId);
  }

  private storeProviderObjectId(providerObjectId: string): void {
    this.storage.updateSandboxModalObjectId(providerObjectId);
  }

  private broadcastSandboxDashboardUrl(providerObjectId: string): void {
    const url = this.config.sandboxDashboardUrlBuilder?.(providerObjectId);
    if (url) {
      this.log.debug("Broadcasting sandbox dashboard URL", {
        provider_object_id: providerObjectId,
      });
      this.broadcaster.broadcast({ type: "sandbox_dashboard_url", url });
    }
  }

  /**
   * Store code-server details in the database and push to connected clients.
   * Shared by doSpawn() and restoreFromSnapshot().
   *
   * The storage adapter may encrypt the password before persisting;
   * the plaintext is broadcast over the already-authenticated WebSocket.
   */
  private async storeAndBroadcastCodeServer(url: string, password: string): Promise<void> {
    this.log.info("Storing and broadcasting code-server info", { url });
    await this.storage.updateSandboxCodeServer(url, password);
    this.broadcaster.broadcast({
      type: "code_server_info",
      url,
      password,
    });
  }

  private parseSandboxSettings(session: SessionRow): SandboxSettings {
    if (!session.sandbox_settings) return {};
    try {
      const parsed: unknown = JSON.parse(session.sandbox_settings);
      return normalizeSandboxSettings(parsed, { invalid: "omit" });
    } catch {
      this.log.warn("Failed to parse sandbox_settings, using defaults");
      return {};
    }
  }

  private async storeAndBroadcastTunnelUrls(
    urls: Record<string, string> | undefined
  ): Promise<void> {
    if (!urls || Object.keys(urls).length === 0) return;
    this.log.info("Storing and broadcasting tunnel URLs", { ports: Object.keys(urls) });
    await this.storage.updateSandboxTunnelUrls(urls);
    this.broadcaster.broadcast({ type: "tunnel_urls", urls });
  }

  /**
   * Mint a terminal JWT, persist the ttyd proxy URL + token, and broadcast to clients.
   * The storage adapter encrypts the token before persisting (same pattern as code-server).
   */
  private async storeAndBroadcastTtyd(
    url: string,
    sandboxAuthToken: string,
    sessionId: string,
    sandboxId: string
  ): Promise<void> {
    const token = await mintJwt(
      {
        sub: sessionId,
        sid: sandboxId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TERMINAL_TOKEN_TTL_SECONDS,
      },
      sandboxAuthToken
    );

    this.log.info("Storing and broadcasting ttyd info", { url });
    await this.storage.updateSandboxTtyd(url, token);
    this.broadcaster.broadcast({ type: "ttyd_info", url, token });
  }

  /**
   * Check if a sandbox spawn is currently in progress.
   * Used by SessionDO to coordinate spawn decisions.
   */
  isSpawning(): boolean {
    return this.isSpawningSandbox;
  }

  /**
   * Notify the manager that a sandbox has connected.
   * Resets the in-memory spawning flag and clears any stale spawn error.
   *
   * Called by SessionDO when sandbox WebSocket connects successfully.
   */
  onSandboxConnected(): void {
    this.isSpawningSandbox = false;
    this.storage.setLastSpawnError(null, null);
  }
}
