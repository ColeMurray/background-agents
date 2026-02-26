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

import type { SandboxStatus } from "../../types";
import type { SandboxRow, SessionRow } from "../../session/types";
import { SandboxProviderError, type SandboxProvider, type CreateSandboxConfig } from "../provider";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateWarmDecision,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  type CircuitBreakerConfig,
  type SpawnConfig,
  type InactivityConfig,
  type HeartbeatConfig,
} from "./decisions";
import { extractProviderAndModel } from "../../utils/models";
import { createLogger, type Logger } from "../../logger";
import { hashToken } from "../../auth/crypto";

const log = createLogger("lifecycle-manager");

// ==================== Dependency Interfaces ====================

/**
 * Sandbox state with circuit breaker info (subset of full SandboxRow).
 */
export interface SandboxCircuitBreakerInfo {
  status: string;
  created_at: number;
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
  controlPlaneUrl: string;
  /** Default model ID used when the session has no model override. */
  model: string;
  /** Session ID for log correlation. Optional — logs will omit sessionId if not provided. */
  sessionId?: string;
}

/**
 * Default lifecycle configuration.
 */
export const DEFAULT_LIFECYCLE_CONFIG: Omit<SandboxLifecycleConfig, "controlPlaneUrl" | "model"> = {
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  spawn: DEFAULT_SPAWN_CONFIG,
  inactivity: DEFAULT_INACTIVITY_CONFIG,
  heartbeat: DEFAULT_HEARTBEAT_CONFIG,
};

/** Child (agent-spawned) sessions get a shorter sandbox timeout. */
const CHILD_SANDBOX_TIMEOUT_SECONDS = 3600; // 1 hour (vs default 2 hours)

// ==================== Repo Image Lookup ====================

/**
 * Lookup interface for pre-built repo images.
 * Returns the latest ready image for a repo, if any.
 */
export interface RepoImageLookup {
  getLatestReady(
    repoOwner: string,
    repoName: string
  ): Promise<{ provider_image_id: string; base_sha: string } | null>;
}

// ==================== Callbacks ====================

/**
 * Optional callbacks from the lifecycle manager to the session DO.
 * Lightweight callback interface — the manager doesn't know what the callbacks do.
 */
export interface LifecycleCallbacks {
  /** Called when the sandbox is being terminated (heartbeat stale, inactivity timeout). */
  onSandboxTerminating?: () => Promise<void>;
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
    private readonly repoImageLookup?: RepoImageLookup
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
      snapshotImageId: sandboxState?.snapshot_image_id || null,
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
    };

    const spawnDecision = evaluateSpawnDecision(
      spawnState,
      this.config.spawn,
      now,
      this.isSpawningSandbox
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
      const sandboxAuthToken = this.idGenerator.generateId();
      const sandboxAuthTokenHash = await hashToken(sandboxAuthToken);
      const expectedSandboxId = `sandbox-${session.repo_owner}-${session.repo_name}-${now}`;

      // Store expected sandbox ID and auth token BEFORE calling provider
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt: now,
        authTokenHash: sandboxAuthTokenHash,
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

      // Look up pre-built repo image (graceful fallback on failure)
      let repoImageId: string | null = null;
      let repoImageSha: string | null = null;
      if (this.repoImageLookup) {
        try {
          const repoImage = await this.repoImageLookup.getLatestReady(
            session.repo_owner,
            session.repo_name
          );
          if (repoImage) {
            repoImageId = repoImage.provider_image_id;
            repoImageSha = repoImage.base_sha;
            this.log.info("Using pre-built repo image", {
              provider_image_id: repoImageId,
              base_sha: repoImageSha,
            });
          }
        } catch (e) {
          this.log.warn("Failed to look up repo image, using base image", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Child sessions get a shorter timeout
      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      // Create sandbox via provider
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
        repoImageId,
        repoImageSha,
        timeoutSeconds,
        branch: session.base_branch,
      };

      const result = await this.provider.createSandbox(createConfig);

      this.log.info("Sandbox spawned", {
        event: "sandbox.spawned",
        sandbox_id: result.sandboxId,
        provider_object_id: result.providerObjectId,
      });

      // Store provider's internal object ID for snapshot API
      if (result.providerObjectId) {
        this.storage.updateSandboxModalObjectId(result.providerObjectId);
      }

      this.storage.updateSandboxStatus("connecting");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

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

      this.storage.updateSandboxStatus("spawning");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "spawning" });

      const now = Date.now();
      const sandboxAuthToken = this.idGenerator.generateId();
      const sandboxAuthTokenHash = await hashToken(sandboxAuthToken);
      const expectedSandboxId = `sandbox-${session.repo_owner}-${session.repo_name}-${now}`;

      // Store expected sandbox ID and auth token
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt: now,
        authTokenHash: sandboxAuthTokenHash,
        modalSandboxId: expectedSandboxId,
      });

      this.log.info("Restoring from snapshot", {
        event: "sandbox.restore",
        snapshot_image_id: snapshotImageId,
      });

      const userEnvVars = await this.storage.getUserEnvVars();
      const { provider, model: modelId } = this.resolveProviderAndModel(session);

      // Child sessions get a shorter timeout (same logic as doSpawn)
      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

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
      });

      if (result.success) {
        this.log.info("Sandbox restored", {
          event: "sandbox.restored",
          sandbox_id: result.sandboxId,
          provider_object_id: result.providerObjectId,
        });

        // Store provider's internal object ID for future snapshots
        if (result.providerObjectId) {
          this.storage.updateSandboxModalObjectId(result.providerObjectId);
        }

        this.storage.updateSandboxStatus("connecting");
        this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });
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
    const isTerminalState =
      sandbox.status === "stopped" || sandbox.status === "stale" || sandbox.status === "failed";
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
    if (sandbox.status === "stopped" || sandbox.status === "failed" || sandbox.status === "stale") {
      this.log.debug("Alarm: sandbox in terminal state, skipping", {
        sandbox_status: sandbox.status,
      });
      return;
    }

    // Check heartbeat health first
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
      // Fire-and-forget snapshot so status broadcast isn't delayed
      this.triggerSnapshot("heartbeat_timeout").catch((e) =>
        this.log.error("Heartbeat snapshot failed", { error: e instanceof Error ? e : String(e) })
      );
      this.storage.updateSandboxStatus("stale");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "stale" });

      // Best-effort shutdown: tell sandbox to exit cleanly (connection may already be dead).
      // Unlike the inactivity path, we don't await the snapshot first — heartbeat stale means
      // the connection is likely already lost, so we prioritize status broadcast over sequencing.
      this.wsManager.sendToSandbox({ type: "shutdown" });
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

    switch (inactivityDecision.action) {
      case "timeout":
        this.log.info("Inactivity timeout", {
          event: "sandbox.timeout",
          last_activity: sandbox.last_activity,
          timeout_ms: this.config.inactivity.timeoutMs,
        });
        // Fail any stuck processing message before terminating
        await this.callbacks.onSandboxTerminating?.();
        // Set status to stopped FIRST to block reconnection attempts
        this.storage.updateSandboxStatus("stopped");
        this.broadcaster.broadcast({ type: "sandbox_status", status: "stopped" });

        // Take snapshot
        await this.triggerSnapshot("inactivity_timeout");

        // Send shutdown command and close WebSocket
        this.wsManager.sendToSandbox({ type: "shutdown" });
        this.wsManager.closeSandboxWebSocket(1000, "Inactivity timeout");

        this.broadcaster.broadcast({
          type: "sandbox_warning",
          message: "Sandbox stopped due to inactivity, snapshot saved",
        });
        return;

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
   * Update last activity timestamp.
   */
  updateLastActivity(timestamp: number): void {
    this.storage.updateSandboxLastActivity(timestamp);
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
   * e.g., "openai/gpt-5.2-codex" -> { provider: "openai", model: "gpt-5.2-codex" }
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

  /**
   * Check if a sandbox spawn is currently in progress.
   * Used by SessionDO to coordinate spawn decisions.
   */
  isSpawning(): boolean {
    return this.isSpawningSandbox;
  }

  /**
   * Notify the manager that a sandbox has connected.
   * Resets the in-memory spawning flag to allow future spawns.
   *
   * Called by SessionDO when sandbox WebSocket connects successfully.
   */
  onSandboxConnected(): void {
    this.isSpawningSandbox = false;
  }
}
