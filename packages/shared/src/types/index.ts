/**
 * Shared type and protocol compatibility barrel.
 *
 * Implementation modules import one another directly; only consumers import
 * through this barrel. Keep internal schemas out of this export surface.
 */

export { attachmentSchema, clientMessageSchema } from "./websocket";
export type { Attachment, ClientMessage } from "./websocket";

export { sessionStatusSchema } from "./statuses";
export type {
  SessionStatus,
  SandboxStatus,
  GitSyncStatus,
  MessageStatus,
  MessageSource,
  ArtifactType,
  EventType,
  ParticipantRole,
  SpawnSource,
  ConfidenceLevel,
} from "./statuses";

export {
  MAX_TARGET_REPOSITORIES,
  MAX_SESSION_REPOSITORIES,
  sessionRepositoryStateSchema,
  prArtifactBelongsToRepo,
  repositoryInputSchema,
  repositoriesInputSchema,
  sessionRepositoriesInputSchema,
  RepositoryPairValidationError,
  decodeRepositoryPathSegments,
  encodeRepositoryPathSegments,
  formatRepositoryFullName,
  parseRepositoryFullName,
  normalizeOptionalRepositoryPair,
} from "./repositories";
export type {
  RepositoryRef,
  SessionRepositoryState,
  SessionListRepository,
  RepositoryInput,
  RepositoryPair,
} from "./repositories";

export type {
  InstallationRepository,
  RepoMetadata,
  EnrichedRepository,
  RepoConfig,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
  ClassificationResult,
} from "./repository-catalog";
export { repoMetadataSchema } from "./repository-catalog";

export { toDisplayStatus } from "./artifacts";
export type {
  SessionArtifact,
  ManualPullRequestArtifactMetadata,
  ScreenshotArtifactMetadata,
  VideoArtifactMetadata,
  PullRequest,
  PullRequestLifecycleState,
  PullRequestStatus,
  PullRequestDisplayStatus,
  PullRequestArtifactMetadata,
  ArtifactResponse,
  ListArtifactsResponse,
  ToolCallSummary,
  ArtifactInfo,
  AgentResponse,
} from "./artifacts";

export { sandboxEventSchema } from "./sandbox-events";
export type { AgentEvent, SandboxEvent, EventResponse, ListEventsResponse } from "./sandbox-events";

export type {
  SessionParticipant,
  Session,
  SessionMessage,
  SessionState,
  ParticipantPresence,
  PullRequestSummary,
} from "./sessions";

export { serverMessageSchema } from "./server-messages";
export type { ServerMessage } from "./server-messages";

export {
  userPreferencesRequestSchema,
  linearCallbackContextSchema,
  linearStartCallbackSchema,
  createSessionRequestSchema,
  createSessionInputSchema,
  createMediaArtifactRequestSchema,
  createSessionResponseSchema,
  sendPromptResponseSchema,
  spawnChildSessionRequestSchema,
  spawnContextSchema,
} from "./session-api";
export type {
  UserPreferences,
  UserPreferencesRequest,
  SlackCallbackContext,
  LinearCallbackContext,
  LinearStartCallback,
  AutomationCallbackContext,
  CallbackContext,
  CreateSessionRequest,
  CreateSessionInput,
  CreateMediaArtifactRequest,
  CreateSessionResponse,
  SendPromptResponse,
  ListSessionsResponse,
  SpawnChildSessionRequest,
  SpawnContext,
  ChildSessionFinalResponse,
  ChildSessionTrajectory,
  ChildSessionDetail,
} from "./session-api";

export {
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_ENVIRONMENT_DESCRIPTION_LENGTH,
  MAX_ENVIRONMENT_CHANNEL_ASSOCIATIONS,
  isEnvironmentId,
  environmentRepositoriesInputSchema,
  createEnvironmentInputSchema,
  updateEnvironmentInputSchema,
} from "./environments";
export type {
  CreateEnvironmentInput,
  UpdateEnvironmentInput,
  EnvironmentRepository,
  Environment,
  ListEnvironmentsResponse,
} from "./environments";

export type {
  AutomationTriggerType,
  AutomationRunStatus,
  AutomationInvocationSource,
  AutomationInvocationStatus,
} from "./automations";

export {
  MAX_AUTOMATION_REPOSITORIES,
  toRepositoryRef,
  automationRepositoryInputSchema,
  automationRepositoriesInputSchema,
} from "./automations";
export type {
  AutomationRepository,
  AutomationRepositoryInput,
  Automation,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  AutomationRun,
  ListAutomationsResponse,
  AutomationInvocation,
  ListAutomationInvocationsResponse,
} from "./automations";

export type {
  ImageBuildStatus,
  ImageBuildScopeKind,
  RepositoryShaEntry,
  ImageBuildRecordView,
  ImageBuildCompleteCallback,
  ImageBuildFailedCallback,
} from "./image-builds";

export { ANALYTICS_DAYS, ANALYTICS_BREAKDOWN_BY } from "./analytics";
export type {
  AnalyticsDays,
  AnalyticsBreakdownBy,
  AnalyticsStatusBreakdown,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesPoint,
  AnalyticsTimeseriesResponse,
  AnalyticsBreakdownEntry,
  AnalyticsBreakdownResponse,
  AnalyticsPullRequestFunnel,
  AnalyticsPullRequestTimeseriesPoint,
  AnalyticsPullRequestRepoEntry,
  AnalyticsPullRequestSourceEntry,
  AnalyticsPullRequestsResponse,
} from "./analytics";

export * from "./integrations";
