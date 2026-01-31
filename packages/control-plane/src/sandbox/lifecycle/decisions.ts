/**
 * Pure decision functions for sandbox lifecycle management.
 *
 * These functions contain no side effects - they take state and configuration
 * as input and return decisions as output. This enables comprehensive unit
 * testing without mocking external dependencies.
 *
 * The SandboxLifecycleManager uses these functions to make decisions,
 * then executes the appropriate side effects (API calls, broadcasts, etc.)
 */

import type { SandboxStatus } from "../../types";

// ==================== Circuit Breaker ====================

/**
 * Circuit breaker state from the database.
 */
export interface CircuitBreakerState {
  /** Number of consecutive spawn failures */
  failureCount: number;
  /** Timestamp of the last spawn failure */
  lastFailureTime: number;
}

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before circuit opens (default: 3) */
  threshold: number;
  /** Time window in ms after which failures reset (default: 5 minutes) */
  windowMs: number;
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  threshold: 3,
  windowMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Circuit breaker decision result.
 */
export interface CircuitBreakerDecision {
  /** Whether spawning should proceed */
  shouldProceed: boolean;
  /** Whether the failure count should be reset (window passed) */
  shouldReset: boolean;
  /** Time remaining in ms until the circuit closes (only set if blocked) */
  waitTimeMs?: number;
}

/**
 * Evaluate whether the circuit breaker allows spawning.
 *
 * The circuit breaker prevents rapid spawn attempts after repeated failures,
 * giving the underlying infrastructure time to recover.
 *
 * @param state - Current circuit breaker state from database
 * @param config - Circuit breaker configuration
 * @param now - Current timestamp
 * @returns Decision with shouldProceed, shouldReset, and optional waitTimeMs
 *
 * @example
 * ```typescript
 * const decision = evaluateCircuitBreaker(
 *   { failureCount: 3, lastFailureTime: now - 60000 },
 *   { threshold: 3, windowMs: 300000 },
 *   now
 * );
 * if (!decision.shouldProceed) {
 *   console.log(`Wait ${decision.waitTimeMs}ms before retrying`);
 * }
 * ```
 */
export function evaluateCircuitBreaker(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerDecision {
  const timeSinceLastFailure = now - state.lastFailureTime;

  // Check if circuit breaker window has passed - reset failures
  if (state.failureCount > 0 && timeSinceLastFailure >= config.windowMs) {
    return {
      shouldProceed: true,
      shouldReset: true,
    };
  }

  // Check if circuit breaker is open (too many failures within window)
  if (state.failureCount >= config.threshold && timeSinceLastFailure < config.windowMs) {
    return {
      shouldProceed: false,
      shouldReset: false,
      waitTimeMs: config.windowMs - timeSinceLastFailure,
    };
  }

  // Circuit is closed, spawning allowed
  return {
    shouldProceed: true,
    shouldReset: false,
  };
}

// ==================== Spawn Decision ====================

/**
 * Sandbox state for spawn decision.
 */
export interface SandboxState {
  /** Current sandbox status */
  status: SandboxStatus;
  /** When the sandbox was created/spawned */
  createdAt: number;
  /** Snapshot image ID if available for restore */
  snapshotImageId: string | null;
  /** Whether an active WebSocket connection exists */
  hasActiveWebSocket: boolean;
}

/**
 * Spawn decision configuration.
 */
export interface SpawnConfig {
  /** Cooldown period in ms between spawn attempts (default: 30s) */
  cooldownMs: number;
  /** Time to wait for WebSocket after spawn (default: 60s) */
  readyWaitMs: number;
}

/**
 * Default spawn configuration.
 */
export const DEFAULT_SPAWN_CONFIG: SpawnConfig = {
  cooldownMs: 30000, // 30 seconds
  readyWaitMs: 60000, // 60 seconds
};

/**
 * Possible spawn actions.
 */
export type SpawnAction =
  | { action: "spawn" }
  | { action: "restore"; snapshotImageId: string }
  | { action: "skip"; reason: string }
  | { action: "wait"; reason: string };

/**
 * Evaluate what spawn action to take.
 *
 * This function encapsulates the complex spawn decision logic:
 * - Restore from snapshot if available and sandbox is stopped/stale/failed
 * - Skip if already spawning/connecting
 * - Skip if ready with active WebSocket
 * - Wait if ready without WebSocket but recently spawned
 * - Wait during cooldown period (unless failed/stopped)
 * - Skip if already spawning in memory
 * - Spawn if all conditions pass
 *
 * @param state - Current sandbox state
 * @param config - Spawn configuration
 * @param now - Current timestamp
 * @param isSpawningInMemory - Whether spawn is already in progress (in-memory flag)
 * @returns The action to take
 *
 * @example
 * ```typescript
 * const decision = evaluateSpawnDecision(
 *   { status: "stopped", createdAt: ..., snapshotImageId: "img-123", hasActiveWebSocket: false },
 *   { cooldownMs: 30000, readyWaitMs: 60000 },
 *   Date.now(),
 *   false
 * );
 * if (decision.action === "restore") {
 *   await provider.restoreFromSnapshot({ snapshotImageId: decision.snapshotImageId, ... });
 * }
 * ```
 */
export function evaluateSpawnDecision(
  state: SandboxState,
  config: SpawnConfig,
  now: number,
  isSpawningInMemory: boolean
): SpawnAction {
  const timeSinceLastSpawn = now - state.createdAt;

  // Check if we have a snapshot to restore from
  // This implements the Ramp spec: restore if sandbox has exited and user sends a follow-up
  if (
    state.snapshotImageId &&
    (state.status === "stopped" || state.status === "stale" || state.status === "failed")
  ) {
    return { action: "restore", snapshotImageId: state.snapshotImageId };
  }

  // Don't spawn if already spawning or connecting (persisted status)
  if (state.status === "spawning" || state.status === "connecting") {
    return { action: "skip", reason: `already ${state.status}` };
  }

  // Don't spawn if status is "ready" and we have an active WebSocket
  if (state.status === "ready") {
    if (state.hasActiveWebSocket) {
      return { action: "skip", reason: "sandbox ready with active WebSocket" };
    }
    // If no WebSocket but was recently spawned, wait for reconnect
    if (timeSinceLastSpawn < config.readyWaitMs) {
      return {
        action: "wait",
        reason: `status ready but no WebSocket, last spawn was ${Math.round(timeSinceLastSpawn / 1000)}s ago`,
      };
    }
  }

  // Cooldown: don't spawn if last spawn was within cooldown period
  // Exception: failed or stopped status bypasses cooldown
  if (
    timeSinceLastSpawn < config.cooldownMs &&
    state.status !== "failed" &&
    state.status !== "stopped"
  ) {
    return {
      action: "wait",
      reason: `last spawn was ${Math.round(timeSinceLastSpawn / 1000)}s ago, waiting`,
    };
  }

  // Check in-memory flag for same-request protection
  if (isSpawningInMemory) {
    return { action: "skip", reason: "spawn already in progress (in-memory flag)" };
  }

  // All checks passed - spawn a new sandbox
  return { action: "spawn" };
}

// ==================== Inactivity Timeout ====================

/**
 * State for inactivity timeout evaluation.
 */
export interface InactivityState {
  /** Last activity timestamp (null if never active) */
  lastActivity: number | null;
  /** Current sandbox status */
  status: SandboxStatus;
  /** Number of connected client WebSockets */
  connectedClientCount: number;
}

/**
 * Inactivity timeout configuration.
 */
export interface InactivityConfig {
  /** Time in ms before sandbox stops due to inactivity (default: 10 minutes) */
  timeoutMs: number;
  /** Additional time granted when clients are connected (default: 5 minutes) */
  extensionMs: number;
  /** Minimum interval between alarm checks (default: 30s) */
  minCheckIntervalMs: number;
}

/**
 * Default inactivity configuration.
 */
export const DEFAULT_INACTIVITY_CONFIG: InactivityConfig = {
  timeoutMs: 10 * 60 * 1000, // 10 minutes
  extensionMs: 5 * 60 * 1000, // 5 minutes
  minCheckIntervalMs: 30000, // 30 seconds
};

/**
 * Possible inactivity actions.
 */
export type InactivityAction =
  | { action: "timeout"; shouldSnapshot: boolean }
  | { action: "extend"; extensionMs: number; shouldWarn: boolean }
  | { action: "schedule"; nextCheckMs: number };

/**
 * Evaluate what action to take for inactivity timeout.
 *
 * The 10-minute default timeout balances cost efficiency with user experience:
 * - Short enough to avoid wasting resources on abandoned sessions
 * - Long enough for users to read/think between prompts
 * - Snapshots preserve all state, so resume is instant
 *
 * @param state - Current inactivity state
 * @param config - Inactivity timeout configuration
 * @param now - Current timestamp
 * @returns The action to take
 *
 * @example
 * ```typescript
 * const decision = evaluateInactivityTimeout(
 *   { lastActivity: now - 600001, status: "ready", connectedClientCount: 1 },
 *   DEFAULT_INACTIVITY_CONFIG,
 *   now
 * );
 * if (decision.action === "extend") {
 *   // Warn user and schedule next check
 *   await scheduleAlarm(now + decision.extensionMs);
 * }
 * ```
 */
export function evaluateInactivityTimeout(
  state: InactivityState,
  config: InactivityConfig,
  now: number
): InactivityAction {
  // Skip for terminal states - they don't need inactivity monitoring
  if (state.status === "stopped" || state.status === "failed" || state.status === "stale") {
    return { action: "schedule", nextCheckMs: config.minCheckIntervalMs };
  }

  // No activity recorded yet - schedule a check
  if (state.lastActivity == null) {
    return { action: "schedule", nextCheckMs: config.minCheckIntervalMs };
  }

  // Only check inactivity for ready or running sandboxes
  if (state.status !== "ready" && state.status !== "running") {
    return { action: "schedule", nextCheckMs: config.minCheckIntervalMs };
  }

  const inactiveTime = now - state.lastActivity;

  // Check if inactivity threshold exceeded
  if (inactiveTime >= config.timeoutMs) {
    // If clients are still connected, they may be actively reviewing
    // Grant an extension and warn them
    if (state.connectedClientCount > 0) {
      return {
        action: "extend",
        extensionMs: config.extensionMs,
        shouldWarn: true,
      };
    }

    // No clients connected - timeout and snapshot
    return { action: "timeout", shouldSnapshot: true };
  }

  // Not yet timed out - schedule next check at remaining time (minimum interval)
  const remainingTime = Math.max(config.timeoutMs - inactiveTime, config.minCheckIntervalMs);
  return { action: "schedule", nextCheckMs: remainingTime };
}

// ==================== Heartbeat Health ====================

/**
 * Heartbeat health configuration.
 */
export interface HeartbeatConfig {
  /** Time in ms after which missing heartbeat indicates stale sandbox (default: 90s = 3x 30s interval) */
  timeoutMs: number;
}

/**
 * Default heartbeat configuration.
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  timeoutMs: 90000, // 90 seconds (3x 30s heartbeat interval)
};

/**
 * Heartbeat health result.
 */
export interface HeartbeatHealth {
  /** Whether the sandbox is considered stale (missed heartbeats) */
  isStale: boolean;
  /** Time since last heartbeat in ms (only set if stale) */
  ageMs?: number;
}

/**
 * Evaluate heartbeat health.
 *
 * Sandboxes send heartbeats every 30 seconds. If no heartbeat is received
 * for 90 seconds (3x interval), the sandbox is considered stale and may
 * be unresponsive.
 *
 * @param lastHeartbeat - Timestamp of last heartbeat (null if never received)
 * @param config - Heartbeat configuration
 * @param now - Current timestamp
 * @returns Health status with isStale flag and optional age
 *
 * @example
 * ```typescript
 * const health = evaluateHeartbeatHealth(
 *   lastHeartbeat,
 *   { timeoutMs: 90000 },
 *   Date.now()
 * );
 * if (health.isStale) {
 *   await triggerSnapshot("heartbeat_timeout");
 *   updateStatus("stale");
 * }
 * ```
 */
export function evaluateHeartbeatHealth(
  lastHeartbeat: number | null,
  config: HeartbeatConfig,
  now: number
): HeartbeatHealth {
  // No heartbeat recorded yet - not stale (sandbox may still be starting)
  if (lastHeartbeat == null) {
    return { isStale: false };
  }

  const heartbeatAge = now - lastHeartbeat;

  if (heartbeatAge > config.timeoutMs) {
    return {
      isStale: true,
      ageMs: heartbeatAge,
    };
  }

  return { isStale: false };
}

// ==================== Warm Decision ====================

/**
 * State for warm sandbox decision.
 */
export interface WarmState {
  /** Whether sandbox WebSocket is connected */
  hasActiveWebSocket: boolean;
  /** Current sandbox status */
  status: SandboxStatus | null;
  /** Whether spawn is in progress (in-memory flag) */
  isSpawningInMemory: boolean;
}

/**
 * Possible warm actions.
 */
export type WarmAction = { action: "spawn" } | { action: "skip"; reason: string };

/**
 * Evaluate whether to warm (proactively spawn) a sandbox.
 *
 * Warming is triggered when a user starts typing, to reduce latency
 * for their first prompt.
 *
 * @param state - Current warm state
 * @returns The action to take
 */
export function evaluateWarmDecision(state: WarmState): WarmAction {
  if (state.hasActiveWebSocket) {
    return { action: "skip", reason: "sandbox already connected" };
  }

  if (state.isSpawningInMemory) {
    return { action: "skip", reason: "already spawning" };
  }

  if (state.status === "spawning" || state.status === "connecting") {
    return { action: "skip", reason: `sandbox status is ${state.status}` };
  }

  return { action: "spawn" };
}
