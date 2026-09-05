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

import type { McpServerConfig, SandboxSettings } from "@open-inspect/shared/types/integrations";
import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import {
  sessionHasRepository,
  type SandboxAccessKind,
  type SandboxRow,
  type SessionRow,
} from "../../session/types";
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
import { parsePersistedSandboxSettings } from "../settings";
import {
  evaluateImageBuildForSpawn,
  type ImageBuildLookup,
  type SelectedImageBuild,
} from "./image-selection";
import type { AlarmScheduler, SessionWebSocket } from "../../platform-ports";
import { DEFAULT_SANDBOX_STATUS } from "../sandbox-status";

export type { ImageBuildLookup } from "./image-selection";
export type { AlarmScheduler } from "../../platform-ports";

const log = createLogger("lifecycle-manager");

/** TTL for terminal auth JWTs (24 hours, matching typical sandbox lifetime). */
const TERMINAL_TOKEN_TTL_SECONDS = 86400;
const PROVIDER_REPLACEMENT_STOP_TIMEOUT_MS = 10_000;

// ==================== Dependency Interfaces ====================

/**
 * One occupancy of the sandbox row: the logical sandbox id plus the
 * `created_at` its reservation or resume stamped. Every write an attempt
 * makes after its first await names the generation it was started for, so a
 * completion that outlives its attempt cannot land on a later one, even one
 * that reached the same status.
 */
export interface SandboxGeneration {
  sandboxId: string | null;
  createdAt: number;
}

/**
 * Sandbox state with circuit breaker info (subset of full SandboxRow).
 */
interface SandboxCircuitBreakerInfo {
  status: SandboxStatus;
  created_at: number;
  modal_object_id: string | null;
  snapshot_image_id: string | null;
  snapshot_runtime_version: string | null;
  spawn_failure_count: number | null;
  last_spawn_failure: number | null;
}

/**
 * The session context a spawn needs alongside sandbox storage. A separate
 * port from `SandboxStorage`: sandbox-row persistence is one collaborator's
 * contract, these reads belong to others, and conflating them forced every
 * implementer to bridge unrelated objects.
 */
export interface SessionContextReader {
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
}

/**
 * Storage adapter for sandbox data operations — the sandbox repository's
 * contract, satisfied by it structurally.
 */
export interface SandboxStorage {
  /** Get current sandbox state */
  getSandbox(): SandboxRow | null;
  /** Get sandbox with circuit breaker state (subset of fields) */
  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerInfo | null;
  /** Update sandbox status */
  updateSandboxStatus(status: SandboxStatus): void;
  /**
   * Move the sandbox from `from` to `to` only while the row still belongs to
   * `generation` and is still in `from`; reports whether it was. The status
   * writes that follow a provider await use this: an alarm, a bridge connect,
   * a cancel, or a newer reservation may have moved the row while the call
   * was in flight, and that verdict stands. Status alone is not enough: a
   * later attempt can bring the row back to the same status.
   */
  transitionSandboxStatus(
    generation: SandboxGeneration,
    from: SandboxStatus,
    to: SandboxStatus
  ): boolean;
  /**
   * Reserve a replacement sandbox identity (status, sandbox ID, created_at).
   * Clears every field describing the previous sandbox instance, runtime
   * version included, and invalidates the stored credentials — phase 1 of
   * the two-phase spawn write (#1589). No token can match the row until
   * `updateSandboxAuthTokenHash` publishes the new hash.
   */
  updateSandboxForSpawn(data: {
    status: SandboxStatus;
    createdAt: number;
    modalSandboxId: string;
    preserveProviderObjectId?: boolean;
  }): void;
  /**
   * Publish the auth-token hash for the identity reserved by
   * `updateSandboxForSpawn` (phase 2 of the two-phase spawn write, #1589).
   * Applies only while that identity is still the persisted sandbox and
   * still `spawning`, and reports whether it was: a delayed publisher must
   * not attach its hash to a newer reservation, and a reservation that a
   * cancel stopped while the hash was computed must not go live.
   */
  updateSandboxAuthTokenHash(modalSandboxId: string, authTokenHash: string): boolean;
  /** Update sandbox state for in-place resume without rotating auth/token identity */
  updateSandboxForResume(data: { status: SandboxStatus; createdAt: number }): void;
  /** Update sandbox Modal object ID (for snapshot API) */
  updateSandboxModalObjectId(modalObjectId: string | null): void;
  /** Set the runtime version describing the sandbox's current filesystem. */
  updateSandboxRuntimeVersion(runtimeVersion: string | null): void;
  /**
   * Record `imageId` as the snapshot of the sandbox identified by
   * `sandboxId`, with the runtime version that produced it (null when
   * the sandbox never reported one). Applies only while that is still the
   * row's sandbox, and reports whether it was: a snapshot completes after a
   * provider await, and a replacement reserved meanwhile must not inherit
   * an image of the sandbox it replaced.
   */
  recordSandboxSnapshot(
    sandboxId: string | null,
    imageId: string,
    runtimeVersion: string | null
  ): boolean;
  /** Update last activity timestamp */
  updateSandboxLastActivity(timestamp: number): void;
  /** Increment circuit breaker failure count */
  incrementCircuitBreakerFailure(timestamp: number): void;
  /** Reset circuit breaker failure count */
  resetCircuitBreaker(): void;
  /** Persist last spawn error */
  setLastSpawnError(error: string | null, timestamp: number | null): void;
  /** Set one access artifact's URL and (encrypted) secret on the sandbox row */
  updateSandboxAccess(kind: SandboxAccessKind, url: string, secret: string): void | Promise<void>;
  /** Clear one access artifact's URL and secret (e.g. on sandbox teardown) */
  clearSandboxAccess(kind: SandboxAccessKind): void;
  /** Clear one access artifact's URL while preserving its stored secret */
  clearSandboxAccessUrl?(kind: SandboxAccessKind): void;
  /** Update tunnel URLs for extra ports on the sandbox row */
  updateSandboxTunnelUrls(urls: Record<string, string>): void | Promise<void>;
  /** Clear stale tunnel URLs (e.g. on sandbox teardown) */
  clearSandboxTunnelUrls(): void;
}

/**
 * Broadcaster for sending messages to connected clients. Satisfied directly
 * by the session messenger — payloads are protocol messages, not loose objects.
 */
export interface SandboxBroadcaster {
  /** Broadcast a message to all connected clients */
  broadcast(message: ServerMessage): void;
}

/**
 * WebSocket manager for sandbox communication.
 */
export interface WebSocketManager {
  /** Get the sandbox WebSocket (with hibernation recovery) */
  getSandboxWebSocket(): SessionWebSocket | null;
  /** Detach the active sandbox dispatch boundary and close its WebSocket. */
  detachSandboxWebSocket(code: number, reason: string): void;
  /** Send a message to the sandbox */
  sendToSandbox(message: object): boolean;
  /** Get count of connected client WebSockets (excludes sandbox) */
  getConnectedClientCount(): number;
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
  /**
   * Session ID for log correlation, resolved per use. Optional — logs will
   * omit sessionId if not provided. A thunk rather than a value because the
   * manager can be constructed during the init request, before the session
   * row (and its public id) exists.
   */
  getSessionId?: () => string;
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
  return repositories.length > 1 || repositories.some((repository) => repository.baseSha)
    ? { repositories }
    : {};
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

// ==================== Manager ====================

/**
 * The narrow lifecycle surface consumed by collaborators (e.g. the session
 * message queue) that spawn sandboxes and record activity but don't manage
 * the rest of the sandbox lifecycle.
 */
export interface SandboxLifecycle {
  spawnSandbox(): Promise<void>;
  updateLastActivity(timestamp: number): void;
  terminateUnresponsiveSandbox(trigger: UnresponsiveSandboxTrigger): Promise<void>;
  terminateFailedSandbox(reason: string): Promise<boolean>;
  reportSandboxError(reason: string): void;
}

export type UnresponsiveSandboxTrigger =
  | "prompt_dispatch_send_failed"
  | "stop_send_failed"
  | "stop_confirmation_timeout";

export type SandboxAlarmResult = "no_action" | "sandbox_failed" | "sandbox_terminated";

/**
 * Manages sandbox lifecycle operations.
 *
 * Uses dependency injection for all external interactions, enabling unit testing
 * with mocked dependencies.
 */
/**
 * A spawn attempt discovered at hash publication that a newer reservation
 * had replaced its identity. The attempt must abandon without failure
 * writes: the sandbox row and circuit breaker now describe the newer
 * attempt, and marking them failed would clobber it.
 */
class SpawnSupersededError extends Error {
  constructor() {
    super("Spawn reservation superseded before its auth hash was published");
    this.name = "SpawnSupersededError";
  }
}

export class SandboxLifecycleManager implements SandboxLifecycle {
  /**
   * In-memory flag to prevent concurrent spawn attempts within the same request.
   * This is NOT persisted - it protects against multiple spawns in one DO method call.
   * The persisted sandbox status ("spawning", "connecting") handles cross-request protection.
   */
  private isSpawningSandbox = false;
  private isTerminatingSandbox = false;
  private providerStartupPending = false;

  /** Memoized session-scoped logger, keyed by the resolved session id. */
  private logMemo?: { sessionId: string | undefined; logger: Logger };

  /**
   * Session-scoped logger. Falls back to the module-level logger if no
   * session id is configured. Re-derived when the resolved id changes, so a
   * manager built before the session row exists picks up the public id.
   */
  private get log(): Logger {
    const sessionId = this.config.getSessionId?.();
    let memo = this.logMemo;
    if (!memo || memo.sessionId !== sessionId) {
      memo = {
        sessionId,
        logger: sessionId ? log.child({ session_id: sessionId }) : log,
      };
      this.logMemo = memo;
    }
    return memo.logger;
  }

  constructor(
    private readonly provider: SandboxProvider,
    private readonly storage: SandboxStorage,
    private readonly sessionContext: SessionContextReader,
    private readonly broadcaster: SandboxBroadcaster,
    private readonly wsManager: WebSocketManager,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly idGenerator: IdGenerator,
    private readonly config: SandboxLifecycleConfig,
    private readonly imageBuildLookup?: ImageBuildLookup
  ) {}

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
      this.reportSandboxError(
        `Sandbox spawning temporarily disabled after ${circuitBreakerState.failureCount} failures. Try again in ${Math.ceil((cbDecision.waitTimeMs || 0) / 1000)} seconds.`
      );
      return;
    }

    // Evaluate spawn decision
    const spawnState = {
      status: sandboxState?.status ?? DEFAULT_SANDBOX_STATUS,
      createdAt: sandboxState?.created_at || 0,
      providerObjectId: sandboxState?.modal_object_id || null,
      snapshotImageId: sandboxState?.snapshot_image_id || null,
      snapshotRuntimeVersion: sandboxState?.snapshot_runtime_version || null,
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
    };

    const spawnDecision = evaluateSpawnDecision(
      spawnState,
      this.config.spawn,
      now,
      this.isSpawningSandbox || this.isTerminatingSandbox,
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
          snapshot_runtime_version: spawnDecision.snapshotRuntimeVersion,
        });
        await this.restoreFromSnapshot(
          spawnDecision.snapshotImageId,
          spawnDecision.snapshotRuntimeVersion
        );
        return;

      case "resume":
        this.log.info("Spawn decision: resume", {
          provider_object_id: spawnDecision.providerObjectId,
        });
        await this.resumeSandbox(spawnDecision.providerObjectId);
        return;

      case "spawn":
        if (spawnDecision.reason) {
          this.log.info("Spawn decision: spawn", {
            event: "sandbox.snapshot_rejected",
            reason: spawnDecision.reason,
            snapshot_image_id: spawnState.snapshotImageId,
          });
        }
        await this.doSpawn();
        return;
    }
  }

  /**
   * Allocate and persist a replacement spawn identity with the two-phase
   * write from #1589. Phase 1, before the first non-storage await: persist
   * the new sandbox ID with credentials invalidated, so a stale bridge that
   * authenticates while the token hashes below fails the sandbox-id and
   * token checks instead of matching the old row. Phase 2: publish the hash,
   * scoped to the reserved identity — the hash-less gap is unobservable
   * because the provider has not been invoked yet.
   */
  private async reserveSpawnIdentity(
    session: SessionRow,
    createdAt: number,
    opts: { preserveProviderObjectId: boolean }
  ): Promise<{ sandboxAuthToken: string; expectedSandboxId: string }> {
    const sandboxAuthToken = this.idGenerator.generateId();
    const expectedSandboxId = buildSandboxIdForSession(session, createdAt);
    await this.enterProviderStartup("spawning", createdAt, () =>
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt,
        modalSandboxId: expectedSandboxId,
        preserveProviderObjectId: opts.preserveProviderObjectId,
      })
    );
    const authTokenHash = await hashToken(sandboxAuthToken);
    if (!this.storage.updateSandboxAuthTokenHash(expectedSandboxId, authTokenHash)) {
      throw new SpawnSupersededError();
    }
    return { sandboxAuthToken, expectedSandboxId };
  }

  /**
   * Execute a fresh sandbox spawn.
   */
  private async doSpawn(): Promise<void> {
    this.isSpawningSandbox = true;
    this.providerStartupPending = true;
    const spawnStartedAt = Date.now();
    let session: SessionRow | null = null;
    let generation: SandboxGeneration | null = null;

    try {
      session = this.sessionContext.getSession();
      if (!session) {
        this.log.error("Cannot spawn sandbox: no session");
        return;
      }

      this.storage.setLastSpawnError(null, null);

      const now = Date.now();
      const sessionId = session.session_name || session.id;
      const hasRepository = sessionHasRepository(session);
      let { sandboxAuthToken, expectedSandboxId } = await this.reserveSpawnIdentity(session, now, {
        preserveProviderObjectId: true,
      });
      generation = { sandboxId: expectedSandboxId, createdAt: now };

      await this.stopPriorProviderSandbox();

      const userEnvVars = await this.sessionContext.getUserEnvVars();
      const { provider, model: modelId } = this.resolveProviderAndModel(session);
      const repositories = this.sessionContext.getSessionRepositories();
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

      const mcpServers = await this.loadMcpServers(repositories);

      const codeServerEnabled = session.code_server_enabled === 1;
      const vncEnabled = session.vnc_enabled === 1;
      const agentSlackNotifyEnabled = await this.resolveAgentSlackNotifyEnabled(session);
      const sandboxSettings = this.parseSandboxSettings(session);
      const timeoutSeconds = this.resolveSandboxTimeoutSeconds(sandboxSettings);
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
        vncEnabled,
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
        ({ sandboxAuthToken, expectedSandboxId } = await this.reserveSpawnIdentity(
          session,
          retryNow,
          { preserveProviderObjectId: false }
        ));
        generation = { sandboxId: expectedSandboxId, createdAt: retryNow };
        result = await this.provider.createSandbox({
          ...createConfig,
          sandboxId: expectedSandboxId,
          sandboxAuthToken,
          prebuiltImageId: null,
          prebuiltImageSha: null,
        });
      }

      if (result.providerObjectId) {
        this.storeAndBroadcastProviderObjectId(result.providerObjectId);
      }
      if (result.codeServerUrl && result.codeServerPassword) {
        await this.storeCodeServer(result.codeServerUrl, result.codeServerPassword);
      }
      if (result.vncAccess) {
        await this.storeVnc(result.vncAccess.url, result.vncAccess.password);
      }
      await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
      if (result.ttydUrl) {
        await this.storeTtyd(result.ttydUrl, sandboxAuthToken, sessionId, expectedSandboxId);
      }

      await this.finishProviderStartup(generation);

      // Reset circuit breaker on successful spawn initiation
      this.storage.resetCircuitBreaker();

      this.log.info("Sandbox spawn completed", {
        event: "sandbox.spawn",
        outcome: "success",
        duration_ms: Date.now() - spawnStartedAt,
        expected_sandbox_id: expectedSandboxId,
        sandbox_id: result.sandboxId,
        provider_object_id: result.providerObjectId,
        repo_owner: session.repo_owner,
        repo_name: session.repo_name,
      });
    } catch (error) {
      if (error instanceof SpawnSupersededError) {
        this.log.warn("Spawn attempt superseded; abandoning", {
          event: "sandbox.spawn_superseded",
        });
        return;
      }
      const errorMessage = error instanceof Error ? error.message : "Failed to spawn sandbox";
      this.log.error("Sandbox spawn completed", {
        event: "sandbox.spawn",
        outcome: "error",
        duration_ms: Date.now() - spawnStartedAt,
        error: error instanceof Error ? error : String(error),
        repo_owner: session?.repo_owner,
        repo_name: session?.repo_name,
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

      this.failAttempt(generation, "spawning", errorMessage);
    } finally {
      this.isSpawningSandbox = false;
      this.providerStartupPending = false;
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
   * Report why the sandbox failed: broadcast it to connected clients and
   * persist it, as one step.
   *
   * `sandbox_error` is how the reason reaches a live UI; `last_spawn_error` is
   * how it survives a reload, since that is what the session snapshot serves as
   * `spawnError`. They are the same fact, so writing one without the other
   * makes the reason visible only until someone refreshes — which is precisely
   * when they are trying to read it.
   *
   * Sandbox status is deliberately not touched here. Most callers mark the
   * sandbox failed themselves, but the circuit breaker reports a reason without
   * changing state, and that distinction is theirs to make.
   */
  reportSandboxError(reason: string): void {
    // Persisting is best effort. `setLastSpawnError` is a bare synchronous
    // sql.exec, so a storage failure would otherwise also cost the broadcast —
    // the one signal an already-open tab gets — and, from the message queue's
    // spawn catch, would replace the spawn error being reported with the
    // storage error. Losing durability is bad; losing both is worse.
    try {
      this.storage.setLastSpawnError(reason, Date.now());
    } catch (error) {
      this.log.warn("Failed to persist sandbox failure reason", {
        event: "sandbox.error_persist_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.broadcaster.broadcast({ type: "sandbox_error", error: reason });
  }

  /**
   * Record that this spawn, restore, or resume attempt failed. The status
   * write applies only while the row still shows the attempt in flight
   * (`inFlight`): a bridge that connected during the provider call has
   * already published `ready` and is serving the session, and an alarm that
   * timed the attempt out has already failed it and told the user. In either
   * case the failure is the provider's, not the sandbox's, and reporting it
   * would persist a spawn error on a session that has none.
   */
  private failAttempt(
    generation: SandboxGeneration | null,
    inFlight: "spawning" | "connecting",
    reason: string
  ): void {
    // No generation: the attempt failed before it reserved anything, so the
    // row still describes whatever came before it and is left alone.
    if (generation && this.storage.transitionSandboxStatus(generation, inFlight, "failed")) {
      this.reportSandboxError(reason);
      return;
    }
    this.log.warn("Sandbox attempt failed after its row moved on; leaving the row as it is", {
      event: "sandbox.attempt_failed_superseded",
      in_flight_status: inFlight,
      attempt_sandbox_id: generation?.sandboxId ?? null,
      sandbox_status: this.storage.getSandbox()?.status ?? null,
      error: reason,
    });
  }

  /**
   * Restore a sandbox from a filesystem snapshot.
   */
  private async restoreFromSnapshot(
    snapshotImageId: string,
    snapshotRuntimeVersion: string
  ): Promise<void> {
    if (!this.provider.restoreFromSnapshot) {
      this.log.info("Provider does not support restore, falling back to fresh spawn");
      // Fall back to fresh spawn
      await this.doSpawn();
      return;
    }

    this.isSpawningSandbox = true;
    this.providerStartupPending = true;
    const restoreStartedAt = Date.now();
    let session: SessionRow | null = null;
    let generation: SandboxGeneration | null = null;

    try {
      session = this.sessionContext.getSession();
      if (!session) {
        this.log.error("Cannot restore: no session");
        return;
      }

      this.storage.setLastSpawnError(null, null);

      const now = Date.now();
      const { sandboxAuthToken, expectedSandboxId } = await this.reserveSpawnIdentity(
        session,
        now,
        { preserveProviderObjectId: true }
      );
      generation = { sandboxId: expectedSandboxId, createdAt: now };

      // A restored sandbox runs the snapshot's binaries whatever the provider
      // exports at launch, so the snapshot's version is the authoritative one.
      // Seeding it here also makes the sandbox's own report a no-op, since the
      // ready handler only fills a row with nothing recorded yet.
      this.storage.updateSandboxRuntimeVersion(snapshotRuntimeVersion);

      await this.stopPriorProviderSandbox();

      const userEnvVars = await this.sessionContext.getUserEnvVars();
      const { provider, model: modelId } = this.resolveProviderAndModel(session);

      const repositories = this.sessionContext.getSessionRepositories();
      const codeServerEnabled = session.code_server_enabled === 1;
      const vncEnabled = session.vnc_enabled === 1;
      const agentSlackNotifyEnabled = await this.resolveAgentSlackNotifyEnabled(session);
      const mcpServers = await this.loadMcpServers(repositories);
      const sandboxSettings = this.parseSandboxSettings(session);
      const timeoutSeconds = this.resolveSandboxTimeoutSeconds(sandboxSettings);
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
        vncEnabled,
        agentSlackNotifyEnabled,
        mcpServers,
        sandboxSettings,
        ...multiRepoSpawnFields(repositories),
      });

      if (result.success) {
        if (result.providerObjectId) {
          this.storeAndBroadcastProviderObjectId(result.providerObjectId);
        }
        if (result.codeServerUrl && result.codeServerPassword) {
          await this.storeCodeServer(result.codeServerUrl, result.codeServerPassword);
        }
        if (result.vncAccess) {
          await this.storeVnc(result.vncAccess.url, result.vncAccess.password);
        }
        await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
        if (result.ttydUrl) {
          await this.storeTtyd(
            result.ttydUrl,
            sandboxAuthToken,
            session.session_name || session.id,
            expectedSandboxId
          );
        }

        await this.finishProviderStartup(generation);

        this.broadcaster.broadcast({
          type: "sandbox_restored",
          message: "Session restored from snapshot",
        });

        this.log.info("Sandbox restore completed", {
          event: "sandbox.restore",
          outcome: "success",
          duration_ms: Date.now() - restoreStartedAt,
          snapshot_image_id: snapshotImageId,
          sandbox_id: result.sandboxId,
          provider_object_id: result.providerObjectId,
          repo_owner: session.repo_owner,
          repo_name: session.repo_name,
        });
      } else {
        this.log.error("Sandbox restore completed", {
          event: "sandbox.restore",
          outcome: "error",
          duration_ms: Date.now() - restoreStartedAt,
          error: result.error,
          snapshot_image_id: snapshotImageId,
          repo_owner: session.repo_owner,
          repo_name: session.repo_name,
        });
        this.failAttempt(generation, "spawning", result.error || "Failed to restore from snapshot");
      }
    } catch (error) {
      if (error instanceof SpawnSupersededError) {
        this.log.warn("Restore attempt superseded; abandoning", {
          event: "sandbox.spawn_superseded",
        });
        return;
      }
      const errorMessage = error instanceof Error ? error.message : "Failed to restore sandbox";
      this.log.error("Sandbox restore completed", {
        event: "sandbox.restore",
        outcome: "error",
        duration_ms: Date.now() - restoreStartedAt,
        error: error instanceof Error ? error : String(error),
        snapshot_image_id: snapshotImageId,
        repo_owner: session?.repo_owner,
        repo_name: session?.repo_name,
      });
      this.failAttempt(generation, "spawning", errorMessage);
    } finally {
      this.isSpawningSandbox = false;
      this.providerStartupPending = false;
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
    this.providerStartupPending = true;
    let generation: SandboxGeneration | null = null;

    try {
      const session = this.sessionContext.getSession();
      const sandbox = this.storage.getSandbox();
      if (!session || !sandbox?.modal_sandbox_id) {
        this.log.error("Cannot resume sandbox: missing session or logical sandbox ID");
        return;
      }

      const now = Date.now();
      generation = { sandboxId: sandbox.modal_sandbox_id, createdAt: now };
      this.storage.setLastSpawnError(null, null);
      await this.enterProviderStartup("connecting", now, () =>
        this.storage.updateSandboxForResume({
          status: "connecting",
          createdAt: now,
        })
      );

      const sandboxSettings = this.parseSandboxSettings(session);
      const timeoutSeconds = this.resolveSandboxTimeoutSeconds(sandboxSettings);

      const result = await this.provider.resumeSandbox({
        providerObjectId,
        sessionId: session.session_name || session.id,
        sandboxId: sandbox.modal_sandbox_id,
        timeoutSeconds,
        codeServerEnabled: session.code_server_enabled === 1,
        vncEnabled: session.vnc_enabled === 1,
        sandboxSettings,
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
        await this.storeCodeServer(result.codeServerUrl, result.codeServerPassword);
      }
      if (result.vncAccess) {
        await this.storeVnc(result.vncAccess.url, result.vncAccess.password);
      }

      await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
      await this.finishProviderStartup(generation);
      this.storage.resetCircuitBreaker();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to resume sandbox";
      this.failAttempt(generation, "connecting", errorMessage);
      this.log.error("Sandbox resume failed", {
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      this.isSpawningSandbox = false;
      this.providerStartupPending = false;
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
    const session = this.sessionContext.getSession();

    if (!sandbox?.modal_object_id || !session) {
      this.log.debug("Cannot snapshot: no modal_object_id or session");
      return;
    }

    // Don't snapshot if already snapshotting
    if (sandbox.status === "snapshotting") {
      this.log.debug("Already snapshotting, skipping");
      return;
    }

    // Everything the completion writes is decided from this read, before the
    // provider await; the writes below are conditional on it still holding.
    const isTerminalState = isDeadSandboxStatus(sandbox.status);
    const previousStatus = sandbox.status;
    const generation: SandboxGeneration = {
      sandboxId: sandbox.modal_sandbox_id,
      createdAt: sandbox.created_at,
    };
    const runtimeVersion = sandbox.runtime_version;

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
        // Stamp the snapshot with the runtime that produced it: the image
        // carries that runtime's binaries, so this is what a later restore is
        // gated on, not whatever the session runs next. Recorded for the
        // sandbox it was taken of; a replacement reserved during the provider
        // call keeps its own restore image.
        if (
          this.storage.recordSandboxSnapshot(generation.sandboxId, result.imageId, runtimeVersion)
        ) {
          this.log.info("Snapshot saved", {
            event: "sandbox.snapshot_saved",
            image_id: result.imageId,
            runtime_version: runtimeVersion,
            reason,
          });
          this.broadcaster.broadcast({
            type: "snapshot_saved",
            imageId: result.imageId,
            reason,
          });
        } else {
          this.log.info("Snapshot completed for a replaced sandbox; not recorded", {
            event: "sandbox.snapshot_superseded",
            image_id: result.imageId,
            sandbox_id: generation.sandboxId,
            reason,
          });
        }
      } else {
        this.log.error("Snapshot failed", { error: result.error, reason });
      }
    } catch (error) {
      this.log.error("Snapshot request failed", {
        error: error instanceof Error ? error : String(error),
        reason,
        modal_object_id: sandbox.modal_object_id,
      });
    }

    // Restore the previous status only while the row is still this sandbox's
    // and still says `snapshotting`: a cancel, a stale heartbeat, or an
    // unresponsive-sandbox termination during the provider call has already
    // retired the sandbox (status written, access cleared, socket detached),
    // and restoring `ready` over that would make the spawn decision wait for
    // a reconnect that cannot come; a replacement that is itself snapshotting
    // keeps its own status.
    if (!isTerminalState && reason !== "heartbeat_timeout") {
      if (this.storage.transitionSandboxStatus(generation, "snapshotting", previousStatus)) {
        this.broadcaster.broadcast({ type: "sandbox_status", status: previousStatus });
        if (previousStatus === "ready") {
          this.broadcaster.broadcast({ type: "sandbox_access_changed" });
        }
      } else {
        this.log.info("Sandbox status moved during snapshot; leaving it", {
          event: "sandbox.snapshot_status_superseded",
          previous_status: previousStatus,
          sandbox_status: this.storage.getSandbox()?.status ?? null,
          reason,
        });
      }
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
   * Stop a sandbox that is about to be replaced before its provider handle is cleared.
   */
  private async stopPriorProviderSandbox(): Promise<void> {
    const providerObjectId = this.storage.getSandbox()?.modal_object_id;
    if (!providerObjectId) {
      return;
    }

    if (!this.canStopProviderSandbox()) {
      this.storage.updateSandboxModalObjectId(null);
      return;
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopTimeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error("Provider stop timed out before sandbox replacement"));
        }, PROVIDER_REPLACEMENT_STOP_TIMEOUT_MS);
      });
      await Promise.race([
        this.stopProviderSandbox("respawn", controller.signal, providerObjectId),
        stopTimeoutPromise,
      ]);
      this.storage.updateSandboxModalObjectId(null);
    } catch (error) {
      this.log.warn("Provider stop failed before sandbox replacement", {
        provider_object_id: providerObjectId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  /**
   * Clear preview URLs after a sandbox is no longer reachable.
   *
   * Persistent resumes preserve code-server and VNC passwords, so only their
   * URLs are cleared. Snapshot restores rotate passwords, so both values are
   * removed.
   */
  private clearSandboxAccessState(): void {
    if (this.usesProviderManagedStop() && this.storage.clearSandboxAccessUrl) {
      this.storage.clearSandboxAccessUrl("codeServer");
      this.storage.clearSandboxAccessUrl("vnc");
    } else {
      this.storage.clearSandboxAccess("codeServer");
      this.storage.clearSandboxAccess("vnc");
    }
    this.storage.clearSandboxTunnelUrls();
    this.storage.clearSandboxAccess("ttyd");
    this.broadcaster.broadcast({ type: "sandbox_access_changed" });
  }

  /**
   * Stop a provider-managed sandbox via its API.
   */
  private async stopProviderSandbox(
    reason: string,
    signal?: AbortSignal,
    providerObjectId?: string
  ): Promise<void> {
    if (!this.provider.stopSandbox) {
      return;
    }

    const sandbox = providerObjectId ? null : this.storage.getSandbox();
    const session = this.sessionContext.getSession();
    const objectId = providerObjectId ?? sandbox?.modal_object_id;
    if (!objectId || !session) {
      return;
    }

    const result = await this.provider.stopSandbox({
      providerObjectId: objectId,
      sessionId: session.session_name || session.id,
      reason,
      signal,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to stop provider sandbox");
    }
  }

  /**
   * Handle alarm for inactivity and heartbeat monitoring.
   */
  async handleAlarm(): Promise<SandboxAlarmResult> {
    const sandbox = this.storage.getSandbox();
    if (!sandbox) {
      this.log.debug("Alarm fired: no sandbox found");
      return "no_action";
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
      return "no_action";
    }

    // Check connecting timeout — sandbox failed to connect within allowed time
    const connectingResult = evaluateConnectingTimeout(
      sandbox.status,
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
      this.reportSandboxError(
        "Sandbox failed to connect within the allowed time. It will be retried on your next message."
      );
      return "sandbox_failed";
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
      this.storage.updateSandboxStatus("stale");
      this.clearSandboxAccessState();
      this.broadcaster.broadcast({ type: "sandbox_status", status: "stale" });

      if (this.usesProviderManagedStop()) {
        try {
          await this.stopProviderSandbox("heartbeat_timeout");
        } catch (error) {
          this.log.warn("Provider stop failed after heartbeat timeout", {
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

      this.wsManager.detachSandboxWebSocket(1000, "Heartbeat stale");
      return "sandbox_terminated";
    }

    // Evaluate inactivity timeout
    const connectedClients = this.getConnectedClientCount();
    const inactivityState = {
      lastActivity: sandbox.last_activity,
      status: sandbox.status,
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
        // Set status to stopped FIRST to block reconnection attempts
        this.storage.updateSandboxStatus("stopped");
        this.clearSandboxAccessState();
        this.broadcaster.broadcast({ type: "sandbox_status", status: "stopped" });

        if (this.usesProviderManagedStop()) {
          try {
            await this.stopProviderSandbox("inactivity_timeout");
          } catch (error) {
            this.log.error("Provider stop failed after inactivity timeout", {
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

        this.wsManager.detachSandboxWebSocket(1000, "Inactivity timeout");
        this.broadcaster.broadcast({
          type: "sandbox_warning",
          message: this.usesProviderManagedStop()
            ? "Sandbox stopped due to inactivity"
            : "Sandbox stopped due to inactivity, snapshot saved",
        });
        return "sandbox_terminated";

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
        await this.alarmScheduler.schedule(now + inactivityDecision.extensionMs);
        return "no_action";

      case "schedule":
        this.log.debug("Scheduling next alarm", { next_check_ms: inactivityDecision.nextCheckMs });
        await this.alarmScheduler.schedule(now + inactivityDecision.nextCheckMs);
        return "no_action";
    }
  }

  async terminateUnresponsiveSandbox(trigger: UnresponsiveSandboxTrigger): Promise<void> {
    const sandbox = this.storage.getSandbox();
    if (!sandbox || isDeadSandboxStatus(sandbox.status)) {
      return;
    }

    const canStopProvider = this.canStopProviderSandbox();
    if (!canStopProvider) this.wsManager.sendToSandbox({ type: "shutdown" });
    this.storage.updateSandboxStatus("stale");
    this.clearSandboxAccessState();
    this.broadcaster.broadcast({ type: "sandbox_status", status: "stale" });
    const closeReason = {
      prompt_dispatch_send_failed: "Prompt dispatch send failed",
      stop_send_failed: "Stop command send failed",
      stop_confirmation_timeout: "Stop confirmation timed out",
    }[trigger];
    this.wsManager.detachSandboxWebSocket(1011, closeReason);
    if (canStopProvider) {
      try {
        await this.stopProviderSandbox(trigger);
      } catch (error) {
        this.log.warn("Provider stop failed for unresponsive sandbox", {
          trigger,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async terminateFailedSandbox(reason: string): Promise<boolean> {
    const sandbox = this.storage.getSandbox();
    if (
      !sandbox ||
      sandbox.status === "stopped" ||
      sandbox.status === "stale" ||
      this.isTerminatingSandbox
    ) {
      return false;
    }

    this.isTerminatingSandbox = true;
    if (sandbox.status !== "failed") {
      this.storage.updateSandboxStatus("failed");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "failed" });
    }
    this.reportSandboxError(reason);
    this.clearSandboxAccessState();

    const canStopProvider = this.canStopProviderSandbox();
    if (!canStopProvider) this.wsManager.sendToSandbox({ type: "shutdown" });
    this.wsManager.detachSandboxWebSocket(1011, "Fatal sandbox runtime error");

    try {
      if (canStopProvider) await this.stopProviderSandbox("fatal_runtime_error");
    } catch (error) {
      this.log.warn("Provider stop failed after fatal runtime error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isTerminatingSandbox = false;
    }
    return true;
  }

  /**
   * Warm sandbox proactively (e.g., when user starts typing).
   */
  async warmSandbox(): Promise<void> {
    const sandbox = this.storage.getSandbox();

    const warmState = {
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
      // Not coerced, deliberately: `WarmState.status` is `SandboxStatus | null`
      // and a session with no sandbox row yet is the ordinary case on the
      // warm-on-typing path. Coercing here would turn "no sandbox" into
      // DEFAULT_SANDBOX_STATUS and skip the spawn this method exists to start.
      status: sandbox?.status ?? null,
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
    await this.alarmScheduler.schedule(alarmTime);
  }

  /**
   * Schedule a disconnect check alarm (heartbeat timeout from now).
   * Used after an active WebSocket disconnect to ensure dead sandboxes are detected
   * promptly. The shared scheduler preserves any earlier deadline in the Durable
   * Object's single alarm slot; the alarm handler evaluates and reschedules all work.
   */
  async scheduleDisconnectCheck(): Promise<void> {
    const alarmTime = Date.now() + this.config.heartbeat.timeoutMs;
    this.log.debug("Scheduling disconnect check", { timeout_ms: this.config.heartbeat.timeoutMs });
    await this.alarmScheduler.schedule(alarmTime);
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
      this.broadcaster.broadcast({ type: "sandbox_access_changed" });
    }
  }

  private async storeCodeServer(url: string, password: string): Promise<void> {
    this.log.info("Storing code-server info", { url });
    await this.storage.updateSandboxAccess("codeServer", url, password);
  }

  private async storeVnc(url: string, password: string): Promise<void> {
    this.log.info("Storing VNC info", { url });
    await this.storage.updateSandboxAccess("vnc", url, password);
  }

  private parseSandboxSettings(session: SessionRow): SandboxSettings {
    try {
      return parsePersistedSandboxSettings(session.sandbox_settings);
    } catch {
      this.log.warn("Failed to parse sandbox_settings, using defaults");
      return {};
    }
  }

  private resolveSandboxTimeoutSeconds(sandboxSettings: SandboxSettings): number | undefined {
    if (!this.provider.capabilities.supportsSandboxTimeout) {
      if (sandboxSettings.sandboxTimeoutMs !== undefined) {
        throw new SandboxProviderError(
          `${this.provider.name} does not support configurable sandbox timeouts`,
          "permanent"
        );
      }
      return undefined;
    }
    const timeoutMs = sandboxSettings.sandboxTimeoutMs;
    return timeoutMs === undefined ? undefined : timeoutMs / 1000;
  }

  private async storeAndBroadcastTunnelUrls(
    urls: Record<string, string> | undefined
  ): Promise<void> {
    if (!urls || Object.keys(urls).length === 0) return;
    this.log.info("Storing and broadcasting tunnel URLs", { ports: Object.keys(urls) });
    await this.storage.updateSandboxTunnelUrls(urls);
    this.broadcaster.broadcast({ type: "sandbox_access_changed" });
  }

  /** Mint and persist terminal access. */
  private async storeTtyd(
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

    this.log.info("Storing ttyd info", { url });
    await this.storage.updateSandboxAccess("ttyd", url, token);
  }

  private async finishProviderStartup(generation: SandboxGeneration): Promise<void> {
    this.providerStartupPending = false;

    if (this.wsManager.getSandboxWebSocket()) {
      this.broadcaster.broadcast({ type: "sandbox_access_changed" });
      return;
    }

    // Only this attempt's own `spawning` advances to `connecting`. A resume
    // entered as `connecting` already; an alarm that timed the attempt out
    // during the provider call has written `failed`; a bridge that connected
    // and dropped has left `ready` or `stale`; a newer reservation owns the
    // row outright. Those stand.
    if (this.storage.transitionSandboxStatus(generation, "spawning", "connecting")) {
      this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });
    }
  }

  private async enterProviderStartup(
    status: "spawning" | "connecting",
    createdAt: number,
    persist: () => void
  ): Promise<void> {
    persist();
    this.broadcaster.broadcast({ type: "sandbox_status", status });
    // The bridge replaces this with its inactivity alarm when it connects.
    await this.alarmScheduler.schedule(createdAt + this.config.connectingTimeout.timeoutMs);
  }

  /**
   * Check if a sandbox spawn is currently in progress.
   * Used by SessionDO to coordinate spawn decisions.
   */
  isSpawning(): boolean {
    return this.isSpawningSandbox || this.isTerminatingSandbox;
  }

  isProviderStartupPending(): boolean {
    return this.providerStartupPending;
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
