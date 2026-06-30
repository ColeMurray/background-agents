/**
 * Shared type definitions used across Open-Inspect packages.
 */

import { z } from "zod";
import type { Attachment } from "./websocket";
export { attachmentSchema, clientMessageSchema } from "./websocket";
export type { Attachment, ClientMessage } from "./websocket";

// Session states
export type SessionStatus =
  | "created"
  | "active"
  | "completed"
  | "failed"
  | "archived"
  | "cancelled";
export type SandboxStatus =
  | "pending"
  | "spawning"
  | "connecting"
  | "warming"
  | "syncing"
  | "ready"
  | "running"
  | "stale"
  | "snapshotting"
  | "stopped"
  | "failed";
export type GitSyncStatus = "pending" | "in_progress" | "completed" | "failed";
export type MessageStatus = "pending" | "processing" | "completed" | "failed";
export type MessageSource = "web" | "slack" | "linear" | "extension" | "github" | "automation";
export type ArtifactType = "pr" | "screenshot" | "video" | "preview" | "branch";
export type EventType =
  | "heartbeat"
  | "token"
  | "tool_call"
  | "step_start"
  | "step_finish"
  | "tool_result"
  | "git_sync"
  | "error"
  | "execution_complete"
  | "artifact"
  | "push_complete"
  | "push_error"
  | "user_message";
export type ParticipantRole = "owner" | "member";
export type SpawnSource =
  | "user"
  | "agent"
  | "automation"
  | "github-bot"
  | "linear-bot"
  | "slack-bot";
export type ConfidenceLevel = "high" | "medium" | "low";

const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);

const recordSchema = z.record(z.string(), z.unknown());

// Participant in a session
export interface SessionParticipant {
  id: string;
  userId: string;
  scmLogin: string | null;
  scmName: string | null;
  scmEmail: string | null;
  role: ParticipantRole;
}

// Session state
export interface Session {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  opencodeSessionId: string | null;
  status: SessionStatus;
  parentSessionId: string | null;
  spawnSource: SpawnSource;
  spawnDepth: number;
  createdAt: number;
  updatedAt: number;
}

// Message in a session
export interface SessionMessage {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  attachments: Attachment[] | null;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// Agent event
export interface AgentEvent {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

// Artifact created by session
export interface SessionArtifact {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * Metadata stored on branch artifacts when PR creation falls back to manual flow.
 */
export interface ManualPullRequestArtifactMetadata {
  mode: "manual_pr";
  head: string;
  base: string;
  createPrUrl: string;
  provider?: string;
}

/** Metadata stored on screenshot artifacts. */
export interface ScreenshotArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type: image/png, image/jpeg, image/webp */
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** File size in bytes */
  sizeBytes: number;
  /** Viewport dimensions at capture time */
  viewport?: { width: number; height: number };
  /** URL that was screenshotted */
  sourceUrl?: string;
  /** Whether this is a full-page screenshot */
  fullPage?: boolean;
  /** Whether element annotations are overlaid */
  annotated?: boolean;
  /** Caption or description provided by the agent */
  caption?: string;
}

/** Metadata stored on video recording artifacts. */
export interface VideoArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type for saved recordings. */
  mimeType: "video/mp4";
  /** File size in bytes */
  sizeBytes: number;
  /** Agent-provided title or description of the validation recording */
  caption: string;
  /** Recording duration in milliseconds */
  durationMs: number;
  /** Artifact creation time as epoch milliseconds */
  createdAt: number;
  /** Recording start time as epoch milliseconds */
  recordingStartedAt: number;
  /** Recording end time as epoch milliseconds */
  recordingEndedAt: number;
  /** Captured viewport dimensions */
  dimensions: { width: number; height: number };
  /** Whether recording stopped at the maximum duration */
  truncated: boolean;
  /** Recordings must not include audio */
  hasAudio?: false;
  /** Captured surface for v1 */
  captureSurface?: "browser";
  /** Artifact source */
  source?: "agent";
  /** URL at recording start */
  sourceUrl?: string;
  /** URL when recording stopped */
  endUrl?: string;
}

// Pull request info
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged" | "draft";
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

const sandboxEventBaseSchema = z.object({
  sandboxId: z.string(),
  timestamp: z.number(),
  ackId: z.string().optional(),
});

const messageSandboxEventBaseSchema = sandboxEventBaseSchema.extend({
  messageId: z.string(),
});

// Sandbox events (from Modal / control-plane synthesized)
export const sandboxEventSchema = z.discriminatedUnion("type", [
  sandboxEventBaseSchema.extend({
    type: z.literal("heartbeat"),
    status: z.string(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("token"),
    content: z.string(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("tool_call"),
    tool: z.string(),
    args: recordSchema,
    callId: z.string(),
    status: z.string().optional(),
    output: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_start"),
    isSubtask: z.boolean().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_finish"),
    cost: z.number().optional(),
    tokens: z.number().optional(),
    reason: z.string().optional(),
    isSubtask: z.boolean().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("tool_result"),
    callId: z.string(),
    result: z.string(),
    error: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("git_sync"),
    status: gitSyncStatusSchema,
    sha: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("error"),
    error: z.string(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("execution_complete"),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("artifact"),
    artifactType: z.string(),
    artifactId: z.string().optional(),
    url: z.string(),
    metadata: recordSchema.optional(),
    messageId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push_complete"),
    branchName: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push_error"),
    branchName: z.string(),
    error: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("session_title"),
    title: z.string(),
  }),
  z.object({
    type: z.literal("user_message"),
    content: z.string(),
    messageId: z.string(),
    timestamp: z.number(),
    ackId: z.string().optional(),
    author: z
      .object({
        participantId: z.string(),
        name: z.string(),
        avatar: z.string().optional(),
      })
      .optional(),
  }),
]);

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;

// WebSocket message types
export type ServerMessage =
  | { type: "pong"; timestamp: number }
  | {
      type: "subscribed";
      sessionId: string;
      state: SessionState;
      artifacts: SessionArtifact[];
      participantId: string;
      participant?: { participantId: string; name: string; avatar?: string };
      replay?: {
        events: SandboxEvent[];
        hasMore: boolean;
        cursor: { timestamp: number; id: string } | null;
      };
      spawnError?: string | null;
    }
  | { type: "prompt_queued"; messageId: string; position: number }
  | { type: "sandbox_event"; event: SandboxEvent }
  | { type: "presence_sync"; participants: ParticipantPresence[] }
  | { type: "presence_update"; participants: ParticipantPresence[] }
  | { type: "presence_leave"; userId: string }
  | { type: "sandbox_warming" }
  | { type: "sandbox_spawning" }
  | { type: "sandbox_status"; status: SandboxStatus }
  | { type: "sandbox_ready" }
  | { type: "sandbox_error"; error: string }
  | { type: "artifact_created"; artifact: SessionArtifact }
  | { type: "session_branch"; branchName: string }
  | { type: "snapshot_saved"; imageId: string; reason: string }
  | { type: "sandbox_restored"; message: string }
  | { type: "sandbox_warning"; message: string }
  | { type: "processing_status"; isProcessing: boolean }
  | {
      type: "history_page";
      items: SandboxEvent[];
      hasMore: boolean;
      cursor: { timestamp: number; id: string } | null;
    }
  | { type: "session_status"; status: SessionStatus }
  | { type: "session_title"; title: string }
  | {
      type: "child_session_update";
      childSessionId: string;
      status: SessionStatus;
      title: string | null;
    }
  | { type: "code_server_info"; url: string; password: string }
  | { type: "ttyd_info"; url: string; token: string }
  | { type: "tunnel_urls"; urls: Record<string, string> }
  | { type: "sandbox_dashboard_url"; url: string }
  | { type: "error"; code: string; message: string };

// Session state sent to clients
export interface SessionState {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  branchName: string | null;
  status: SessionStatus;
  sandboxStatus: SandboxStatus;
  messageCount: number;
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  isProcessing?: boolean;
  parentSessionId?: string | null;
  totalCost?: number;
  codeServerUrl?: string | null;
  codeServerPassword?: string | null;
  tunnelUrls?: Record<string, string> | null;
  ttydUrl?: string | null;
  ttydToken?: string | null;
  sandboxDashboardUrl?: string | null;
}

// Participant presence info
export interface ParticipantPresence {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

// Repository types for GitHub App installation
export interface InstallationRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  language?: string | null;
  topics?: string[];
}

export interface RepoMetadata {
  description?: string;
  aliases?: string[];
  channelAssociations?: string[];
  keywords?: string[];
}

export interface EnrichedRepository extends InstallationRepository {
  metadata?: RepoMetadata;
}

// Bot package shared types
export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  displayName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  language?: string | null;
  topics?: string[];
  aliases?: string[];
  keywords?: string[];
  channelAssociations?: string[];
}

export type ControlPlaneRepo = EnrichedRepository;

export interface ControlPlaneReposResponse {
  repos: ControlPlaneRepo[];
  cached: boolean;
  cachedAt: string;
}

export interface ClassificationResult {
  repo: RepoConfig | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives?: RepoConfig[];
  needsClarification: boolean;
}

export interface EventResponse {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventsResponse {
  events: EventResponse[];
  cursor?: string;
  hasMore: boolean;
}

export interface ArtifactResponse {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactResponse[];
}

export interface ToolCallSummary {
  tool: string;
  summary: string;
}

export interface ArtifactInfo {
  type: ArtifactType;
  url: string;
  label: string;
  metadata?: Record<string, unknown> | null;
}

export interface AgentResponse {
  textContent: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactInfo[];
  success: boolean;
  error?: string;
}

export interface UserPreferences {
  userId: string;
  model?: string;
  reasoningEffort?: string;
  branch?: string;
  updatedAt: number;
}

export const userPreferencesRequestSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type UserPreferencesRequest = z.infer<typeof userPreferencesRequestSchema>;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

// ─── Callback Context (discriminated union) ──────────────────────────────────

export interface SlackCallbackContext {
  source: "slack";
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  reactionMessageTs?: string;
}

export interface LinearCallbackContext {
  source: "linear";
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  repoFullName: string;
  model: string;
  agentSessionId?: string;
  organizationId?: string;
  emitToolProgressActivities?: boolean;
}

export interface AutomationCallbackContext {
  source: "automation";
  automationId: string;
  runId: string;
  automationName: string;
}

export type CallbackContext =
  | SlackCallbackContext
  | LinearCallbackContext
  | AutomationCallbackContext;

function hasRepositoryIdentifier(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// API response types
export const createSessionRequestSchema = z
  .object({
    repoOwner: z.string().nullish(),
    repoName: z.string().nullish(),
    title: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    branch: z.string().optional(),
  })
  .refine(
    (data) => hasRepositoryIdentifier(data.repoOwner) === hasRepositoryIdentifier(data.repoName),
    {
      message: "repoOwner and repoName must be provided together",
      path: ["repoName"],
    }
  )
  .refine((data) => hasRepositoryIdentifier(data.repoOwner) || !data.branch?.trim(), {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionInputSchema = createSessionRequestSchema.extend({
  userId: z.string().optional(),
  spawnSource: spawnSourceSchema.optional(),
  authProvider: z.enum(["github", "google"]).optional(),
  authUserId: z.string().optional(),
  authEmail: z.string().optional(),
  authName: z.string().optional(),
  authAvatarUrl: z.string().optional(),
  scmUserId: z.string().optional(),
  scmLogin: z.string().optional(),
  scmName: z.string().optional(),
  scmEmail: z.string().optional(),
  scmAvatarUrl: z.string().optional(),
  actorUserId: z.string().optional(),
  actorDisplayName: z.string().optional(),
  actorEmail: z.string().optional(),
  actorAvatarUrl: z.string().optional(),
  scmToken: z.string().optional(),
  scmRefreshToken: z.string().optional(),
  scmTokenExpiresAt: z.number().optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const createMediaArtifactRequestSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  objectKey: z.string(),
  metadata: recordSchema.optional(),
});

export type CreateMediaArtifactRequest = z.infer<typeof createMediaArtifactRequestSchema>;

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
}

export interface ListSessionsResponse {
  sessions: Session[];
  cursor?: string;
  hasMore: boolean;
}

// --- Agent-spawned sub-sessions ---

/** Request body for POST /sessions/:parentId/children */
export interface SpawnChildSessionRequest {
  title: string;
  prompt: string;
  repoOwner?: string;
  repoName?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Returned by parent DO's GET /internal/spawn-context */
export interface SpawnContext {
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  model: string;
  reasoningEffort: string | null;
  baseBranch: string | null;
  owner: {
    userId: string;
    scmUserId: string | null;
    scmLogin: string | null;
    scmName: string | null;
    scmEmail: string | null;
    scmAccessTokenEncrypted: string | null;
    scmRefreshTokenEncrypted: string | null;
    scmTokenExpiresAt: number | null;
  };
}

/** Returned by child DO's GET /internal/child-summary */
export interface ChildSessionFinalResponse extends AgentResponse {
  messageId: string;
  completedAt: number | null;
  eventCount: number;
  eventLimitReached: boolean;
}

export interface ChildSessionTrajectory {
  events: EventResponse[];
  hasMore: boolean;
  cursor?: string;
  limit: number;
}

export interface ChildSessionDetail {
  session: {
    id: string;
    title: string;
    status: SessionStatus;
    repoOwner: string | null;
    repoName: string | null;
    branchName: string | null;
    model: string;
    createdAt: number;
    updatedAt: number;
  };
  sandbox: { status: SandboxStatus } | null;
  artifacts: Array<{ type: string; url: string; metadata: unknown }>;
  recentEvents: Array<{ type: string; data: unknown; createdAt: number }>;
  finalResponse?: ChildSessionFinalResponse | null;
  trajectory?: ChildSessionTrajectory;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export const ANALYTICS_DAYS = [7, 14, 30, 90] as const;
export type AnalyticsDays = (typeof ANALYTICS_DAYS)[number];

export const ANALYTICS_BREAKDOWN_BY = ["user", "repo"] as const;
export type AnalyticsBreakdownBy = (typeof ANALYTICS_BREAKDOWN_BY)[number];

export interface AnalyticsStatusBreakdown {
  created: number;
  active: number;
  completed: number;
  failed: number;
  archived: number;
  cancelled: number;
}

export interface AnalyticsSummaryResponse {
  totalSessions: number;
  activeUsers: number;
  totalCost: number;
  avgCost: number;
  totalPrs: number;
  statusBreakdown: AnalyticsStatusBreakdown;
}

export interface AnalyticsTimeseriesPoint {
  date: string;
  groups: Record<string, number>;
}

export interface AnalyticsTimeseriesResponse {
  series: AnalyticsTimeseriesPoint[];
}

export interface AnalyticsBreakdownEntry {
  key: string;
  displayName?: string;
  sessions: number;
  completed: number;
  failed: number;
  cancelled: number;
  cost: number;
  prs: number;
  messageCount: number;
  avgDuration: number;
  lastActive: number;
}

export interface AnalyticsBreakdownResponse {
  entries: AnalyticsBreakdownEntry[];
}

// ─── Automation Engine ────────────────────────────────────────────────────────

export type AutomationTriggerType =
  | "schedule"
  | "github_event"
  | "linear_event"
  | "sentry"
  | "webhook"
  | "slack_event";

export type AutomationRunStatus = "starting" | "running" | "completed" | "failed" | "skipped";

// Re-export TriggerConfig for use in automation interfaces below
import type { TriggerConfig } from "../triggers/conditions";

export interface Automation {
  id: string;
  name: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  scheduleCron: string | null;
  scheduleTz: string;
  model: string;
  reasoningEffort: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  eventType: string | null;
  triggerConfig: TriggerConfig | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  repoId: number | null;
}

export interface CreateAutomationRequest {
  name: string;
  instructions: string;
  triggerType?: AutomationTriggerType;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
}

export interface UpdateAutomationRequest {
  name?: string;
  instructions?: string;
  repoOwner?: string | null;
  repoName?: string | null;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  baseBranch?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  sessionId: string | null;
  status: AutomationRunStatus;
  skipReason: string | null;
  failureReason: string | null;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  sessionTitle: string | null;
  artifactSummary: string | null;
  triggerKey: string | null;
  concurrencyKey: string | null;
}

export interface ListAutomationsResponse {
  automations: Automation[];
  total: number;
}

export interface ListAutomationRunsResponse {
  runs: AutomationRun[];
  total: number;
}

export * from "./integrations";
