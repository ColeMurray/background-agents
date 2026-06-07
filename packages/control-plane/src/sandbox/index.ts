/**
 * Sandbox module exports.
 */

// Client
export {
  ModalClient,
  createModalClient,
  type CreateSandboxRequest,
  type CreateSandboxResponse,
  type WarmSandboxRequest,
  type WarmSandboxResponse,
} from "./client";

// Provider interface
export {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SnapshotConfig,
  type SnapshotResult,
  type SandboxErrorType,
} from "./provider";

// Modal provider
export { ModalSandboxProvider, createModalProvider } from "./providers/modal-provider";
export { DaytonaSandboxProvider, createDaytonaProvider } from "./providers/daytona-provider";
export {
  VercelSandboxProvider,
  createVercelProvider,
  type VercelProviderConfig,
  type TriggerVercelRepoImageBuildConfig,
  type TriggerVercelRepoImageBuildResult,
} from "./providers/vercel-provider";
export {
  VercelSandboxClient,
  VercelSandboxApiError,
  createVercelSandboxClient,
  type VercelSandboxClientConfig,
  type VercelCreateSandboxRequest,
  type VercelCreateSandboxResponse,
  type VercelSandboxRoute,
  type VercelSandboxSession,
} from "./vercel-client";
export {
  buildVercelBaseSnapshot,
  buildBaseSnapshotSandboxName,
  type BuildVercelBaseSnapshotConfig,
  type BuildVercelBaseSnapshotResult,
} from "./vercel-base-snapshot";
export {
  DEFAULT_VERCEL_RUNTIME,
  VERCEL_LOCAL_RUNTIME_EXTRACT_DIR,
  VERCEL_PYTHON_BIN,
  buildVercelBootstrapScript,
} from "./vercel-bootstrap";
export {
  DaytonaRestClient,
  DaytonaNotFoundError,
  DaytonaApiError,
  createDaytonaRestClient,
  type DaytonaRestConfig,
  type DaytonaSandboxResponse,
  type DaytonaCreateSandboxParams,
} from "./daytona-rest-client";
export {
  resolveSandboxBackendName,
  isModalSandboxBackend,
  supportsRepoImageBackend,
  type SandboxBackendName,
} from "./provider-name";

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
