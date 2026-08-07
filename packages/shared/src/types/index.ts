/**
 * Shared type and protocol compatibility barrel.
 *
 * Implementation modules import one another directly; only consumers import
 * through this barrel. Keep internal schemas out of this export surface.
 */

export {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  sessionAttachmentMimeTypeSchema,
  sessionAttachmentIdSchema,
  sessionAttachmentReferenceSchema,
  sessionAttachmentReferencesSchema,
  resolvedSessionAttachmentSchema,
  resolvedSessionAttachmentsSchema,
} from "./session-attachments";
export type {
  SessionAttachmentMimeType,
  SessionAttachmentReference,
  ResolvedSessionAttachment,
} from "./session-attachments";

export { clientMessageSchema } from "./websocket";
export type { ClientMessage } from "./websocket";

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

export {
  installationRepositorySchema,
  repoMetadataSchema,
  enrichedRepositorySchema,
  repoConfigSchema,
  controlPlaneReposResponseSchema,
} from "./repository-catalog";
export type {
  InstallationRepository,
  RepoMetadata,
  EnrichedRepository,
  RepoConfig,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
  ClassificationResult,
  ConfidenceLevel,
} from "./repository-catalog";

export { listArtifactsResponseSchema, toDisplayStatus } from "./artifacts";
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
  MediaArtifactInfo,
  AgentResponse,
  ArtifactType,
} from "./artifacts";
export { sessionArtifactSchema } from "./artifacts";

export {
  eventResponseSchema,
  eventTypeSchema,
  listEventsResponseSchema,
  sandboxEventSchema,
  toolCallIdentityKey,
  toolCallIdentityTuple,
} from "./sandbox-events";
export type {
  AgentEvent,
  SandboxEvent,
  EventResponse,
  ListEventsResponse,
  GitSyncStatus,
  EventType,
} from "./sandbox-events";

export type {
  SessionParticipant,
  Session,
  SessionMessage,
  PullRequestSummary,
  SessionReadState,
  SessionReadAction,
  SessionReadResult,
  SessionParticipantProfile,
  SessionParticipantProfilesResponse,
  SessionStatus,
  SandboxStatus,
  MessageStatus,
  MessageSource,
  ParticipantRole,
  SpawnSource,
} from "./sessions";
export {
  messageSourceSchema,
  sessionStatusSchema,
  sessionReadActionSchema,
  sessionReadResultSchema,
  sessionParticipantProfileSchema,
  sessionParticipantProfilesResponseSchema,
} from "./sessions";

export { serverMessageSchema } from "./server-messages";
export type { ServerMessage, SessionState, ParticipantPresence } from "./server-messages";

export {
  SESSION_DIFF_VERSION,
  SESSION_DIFF_MAX_FILES,
  SESSION_DIFF_MAX_FILE_PATCH_BYTES,
  SESSION_DIFF_MAX_TOTAL_PATCH_BYTES,
  SESSION_DIFF_MAX_BUNDLE_BYTES,
  SESSION_DIFF_FAILURE_BODY_MAX_BYTES,
  SESSION_DIFF_MAX_ERROR_LENGTH,
  SESSION_DIFF_REFRESH_TIMEOUT_MS,
  SESSION_DIFF_ID_PATTERN,
  SESSION_DIFF_REVISION_STALE_CODE,
  SESSION_DIFF_FILE_NOT_FOUND_CODE,
  SESSION_DIFF_ERROR_CODES,
  isSessionDiffErrorCode,
  diffRenderStateSchema,
  diffFileStatusSchema,
  sessionDiffBaselineRepositorySchema,
  sessionDiffFileUploadSchema,
  sessionDiffFileSchema,
  sessionDiffRepositoryUploadSchema,
  sessionDiffRepositorySchema,
  sessionDiffUploadSchema,
  storedSessionDiffBundleSchema,
  sessionDiffManifestSchema,
  sessionDiffStateSchema,
  sessionDiffFailureSchema,
  toSessionDiffManifest,
} from "./session-diffs";
export type {
  SessionDiffErrorCode,
  DiffRenderState,
  DiffFileStatus,
  SessionDiffBaselineRepository,
  SessionDiffFileUpload,
  SessionDiffFile,
  SessionDiffRepositoryUpload,
  SessionDiffRepository,
  SessionDiffUpload,
  StoredSessionDiffBundle,
  SessionDiffManifest,
  SessionDiffState,
  SessionDiffFailure,
} from "./session-diffs";

export {
  automationCallbackContextSchema,
  callbackContextSchema,
  linearCallbackContextSchema,
  linearStartCallbackSchema,
  sendPromptRequestSchema,
  slackCallbackContextSchema,
  createSessionRequestSchema,
  createSessionInputSchema,
  createMediaArtifactRequestSchema,
  createSessionResponseSchema,
  sendPromptResponseSchema,
  spawnChildSessionRequestSchema,
  cancelChildSessionRequestSchema,
} from "./session-api";
export type {
  UserPreferences,
  SlackCallbackContext,
  LinearCallbackContext,
  LinearStartCallback,
  AutomationCallbackContext,
  CallbackContext,
  SendPromptRequest,
  CreateSessionRequest,
  CreateSessionInput,
  CreateMediaArtifactRequest,
  CreateSessionResponse,
  SendPromptResponse,
  ListSessionsResponse,
  SpawnChildSessionRequest,
  CancelChildSessionRequest,
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
  environmentRepositorySchema,
  environmentSchema,
  listEnvironmentsResponseSchema,
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
  AutomationRunStatus,
  AutomationInvocationSource,
  AutomationInvocationStatus,
} from "./automations";
export type { AutomationTriggerType } from "../triggers/types";

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

export {
  MAX_COMMIT_SIGNING_PRIVATE_KEY_LENGTH,
  commitSigningMetadataSchema,
  commitSigningWriteRequestSchema,
} from "./commit-signing";
export type { CommitSigningMetadata, CommitSigningWriteRequest } from "./commit-signing";

export { formatGitHubNoreplyEmail, githubLoginSchema } from "./github-identity";

export * from "./integrations";
