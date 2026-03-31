/**
 * Sandbox module exports.
 */

// Provider interface
export {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SnapshotConfig,
  type SnapshotResult,
  type SandboxErrorType,
} from "./provider";

// Lifecycle decisions
export {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateWarmDecision,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
  type CircuitBreakerDecision,
  type SandboxState,
  type SpawnConfig,
  type SpawnAction,
  type InactivityState,
  type InactivityConfig,
  type InactivityAction,
  type HeartbeatConfig,
  type HeartbeatHealth,
  type WarmState,
  type WarmAction,
} from "./lifecycle/decisions";

// Lifecycle manager
export {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
  type SandboxLifecycleConfig,
} from "./lifecycle/manager";
