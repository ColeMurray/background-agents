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
  sessionAttachmentUploadResponseSchema,
} from "./session-attachments";
export type {
  SessionAttachmentMimeType,
  SessionAttachmentReference,
  ResolvedSessionAttachment,
  SessionAttachmentUploadResponse,
} from "./session-attachments";

export { clientMessageSchema, clientRequestIdSchema } from "./websocket";
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

export {
  serverMessageSchema,
  sessionSnapshotSchema,
  sessionSnapshotStateSchema,
  sessionTimelineEventSchema,
} from "./server-messages";
export type {
  ParticipantPresence,
  PromptQueueItem,
  ServerMessage,
  SessionSnapshot,
  SessionSnapshotState,
  SessionState,
  SessionTimelineEvent,
} from "./server-messages";

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
  listAutomationsResponseSchema,
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

export {
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_COMPATIBILITY_LENGTH,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_REVISION_BYTES,
  MAX_SKILL_PATH_BYTES,
  MAX_SKILL_PATH_DEPTH,
  MAX_MANAGED_SKILLS_PER_SESSION,
  MAX_MANAGED_SKILL_MANIFEST_BYTES,
  skillNameSchema,
  skillFileInputSchema,
  skillMetadataSchema,
  skillContentInputSchema,
  skillAssignmentInputSchema,
  createSkillInputSchema,
  setSkillEnabledInputSchema,
  replaceSkillContentAndAssignmentsInputSchema,
  skillFileSchema,
  skillAssignmentSchema,
  skillSummarySchema,
  skillSchema,
  listSkillsResponseSchema,
  skillResponseSchema,
  createSkillProfileInputSchema,
  updateSkillProfileInputSchema,
  skillProfileSchema,
  listSkillProfilesResponseSchema,
  skillProfileResponseSchema,
  sessionSkillSelectionSchema,
  skillResolutionPreviewInputSchema,
  resolvedSkillSchema,
  skillResolutionPreviewResponseSchema,
  sessionSkillsViewSchema,
  sandboxSkillInstallationSchema,
} from "./skills";
export type {
  SkillFileInput,
  SkillContentInput,
  SkillAssignmentInput,
  CreateSkillInput,
  SetSkillEnabledInput,
  ReplaceSkillContentAndAssignmentsInput,
  SkillFile,
  SkillAssignment,
  SkillSummary,
  Skill,
  SkillProfile,
  SessionSkillSelection,
  SessionSkillManifestSelection,
  ResolvedSkill,
  SessionSkillsView,
  SandboxSkillInstallation,
} from "./skills";

export { formatGitHubNoreplyEmail, githubLoginSchema } from "./github-identity";

export * from "./integrations";
