/**
 * Pure decision functions for sandbox lifecycle management.
 *
 * These functions contain no side effects - they take state and configuration
 * as input and return decisions as output. This enables comprehensive unit
 * testing without mocking external dependencies.
 *
 * Kept as-is from the original -- these are pure functions with no platform dependencies.
 */

import type { SandboxStatus } from "../../types";

// ==================== Circuit Breaker ====================

export interface CircuitBreakerState {
  failureCount: number;
  lastFailureTime: number;
}

export interface CircuitBreakerConfig {
  threshold: number;
  windowMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  threshold: 3,
  windowMs: 5 * 60 * 1000,
};

export interface CircuitBreakerDecision {
  shouldProceed: boolean;
  shouldReset: boolean;
  waitTimeMs?: number;
}

export function evaluateCircuitBreaker(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number,
): CircuitBreakerDecision {
  const timeSinceLastFailure = now - state.lastFailureTime;

  if (state.failureCount > 0 && timeSinceLastFailure >= config.windowMs) {
    return { shouldProceed: true, shouldReset: true };
  }

  if (state.failureCount >= config.threshold && timeSinceLastFailure < config.windowMs) {
    return {
      shouldProceed: false,
      shouldReset: false,
      waitTimeMs: config.windowMs - timeSinceLastFailure,
    };
  }

  return { shouldProceed: true, shouldReset: false };
}

// ==================== Spawn Decision ====================

export interface SandboxState {
  status: SandboxStatus;
  createdAt: number;
  snapshotImageId: string | null;
  hasActiveWebSocket: boolean;
}

export interface SpawnConfig {
  cooldownMs: number;
  readyWaitMs: number;
}

export const DEFAULT_SPAWN_CONFIG: SpawnConfig = {
  cooldownMs: 30000,
  readyWaitMs: 60000,
};

export type SpawnAction =
  | { action: "spawn" }
  | { action: "restore"; snapshotImageId: string }
  | { action: "skip"; reason: string }
  | { action: "wait"; reason: string };

export function evaluateSpawnDecision(
  state: SandboxState,
  config: SpawnConfig,
  now: number,
  isSpawningInMemory: boolean,
): SpawnAction {
  const timeSinceLastSpawn = now - state.createdAt;

  if (
    state.snapshotImageId &&
    (state.status === "stopped" || state.status === "stale" || state.status === "failed")
  ) {
    return { action: "restore", snapshotImageId: state.snapshotImageId };
  }

  if (state.status === "spawning" || state.status === "connecting") {
    return { action: "skip", reason: `already ${state.status}` };
  }

  if (state.status === "ready") {
    if (state.hasActiveWebSocket) {
      return { action: "skip", reason: "sandbox ready with active WebSocket" };
    }
    if (timeSinceLastSpawn < config.readyWaitMs) {
      return {
        action: "wait",
        reason: `status ready but no WebSocket, last spawn was ${Math.round(timeSinceLastSpawn / 1000)}s ago`,
      };
    }
  }

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

  if (isSpawningInMemory) {
    return { action: "skip", reason: "spawn already in progress (in-memory flag)" };
  }

  return { action: "spawn" };
}

// ==================== Inactivity Timeout ====================

export interface InactivityState {
  lastActivity: number | null;
  status: SandboxStatus;
  connectedClientCount: number;
}

export interface InactivityConfig {
  timeoutMs: number;
  extensionMs: number;
  minCheckIntervalMs: number;
}

export const DEFAULT_INACTIVITY_CONFIG: InactivityConfig = {
  timeoutMs: 10 * 60 * 1000,
  extensionMs: 5 * 60 * 1000,
  minCheckIntervalMs: 30000,
};

export type InactivityAction =
  | { action: "timeout"; shouldSnapshot: boolean }
  | { action: "extend"; extensionMs: number; shouldWarn: boolean }
  | { action: "schedule"; nextCheckMs: number };

export function evaluateInactivityTimeout(
  state: InactivityState,
  config: InactivityConfig,
  now: number,
): InactivityAction {
  if (state.status === "stopped" || state.status === "failed" || state.status === "stale") {
    return { action: "schedule", nextCheckMs: config.minCheckIntervalMs };
  }

  if (state.lastActivity == null) {
    return { action: "schedule", nextCheckMs: config.minCheckIntervalMs };
  }

  if (state.status !== "ready" && state.status !== "running") {
    return { action: "schedule", nextCheckMs: config.minCheckIntervalMs };
  }

  const inactiveTime = now - state.lastActivity;

  if (inactiveTime >= config.timeoutMs) {
    if (state.connectedClientCount > 0) {
      return { action: "extend", extensionMs: config.extensionMs, shouldWarn: true };
    }
    return { action: "timeout", shouldSnapshot: true };
  }

  const remainingTime = Math.max(config.timeoutMs - inactiveTime, config.minCheckIntervalMs);
  return { action: "schedule", nextCheckMs: remainingTime };
}

// ==================== Heartbeat Health ====================

export interface HeartbeatConfig {
  timeoutMs: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  timeoutMs: 90000,
};

export interface HeartbeatHealth {
  isStale: boolean;
  ageMs?: number;
}

export function evaluateHeartbeatHealth(
  lastHeartbeat: number | null,
  config: HeartbeatConfig,
  now: number,
): HeartbeatHealth {
  if (lastHeartbeat == null) {
    return { isStale: false };
  }

  const heartbeatAge = now - lastHeartbeat;

  if (heartbeatAge > config.timeoutMs) {
    return { isStale: true, ageMs: heartbeatAge };
  }

  return { isStale: false };
}

// ==================== Warm Decision ====================

export interface WarmState {
  hasActiveWebSocket: boolean;
  status: SandboxStatus | null;
  isSpawningInMemory: boolean;
}

export type WarmAction = { action: "spawn" } | { action: "skip"; reason: string };

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
