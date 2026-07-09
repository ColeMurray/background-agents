/**
 * Shared type definitions used across Open-Inspect packages.
 */

import { z } from "zod";
import type { Attachment } from "./websocket";
export { attachmentSchema, clientMessageSchema } from "./websocket";
export type { Attachment, ClientMessage } from "./websocket";

// Session states
export const sessionStatusSchema = z.enum([
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
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
  | "ready"
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
  | "warning"
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

const sandboxStatusSchema = z.enum([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
  "ready",
  "running",
  "stale",
  "snapshotting",
  "stopped",
  "failed",
]);
const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const artifactTypeSchema = z.enum(["pr", "screenshot", "video", "preview", "branch"]);
const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);

const recordSchema = z.record(z.string(), z.unknown());
const tokenUsageDetailsSchema = z
  .object({
    total: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache: z
      .object({
        read: z.number().optional(),
        write: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (usage) =>
      typeof usage.total === "number" ||
      typeof usage.input === "number" ||
      typeof usage.output === "number" ||
      typeof usage.reasoning === "number" ||
      typeof usage.cache?.read === "number" ||
      typeof usage.cache?.write === "number",
    { message: "Expected at least one token usage count" }
  );
const tokenUsageSchema = z.union([z.number(), tokenUsageDetailsSchema]);

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
  /**
   * Ordered member list; [0] = primary. Absent on scalar-era sessions —
   * consumers fall back to the scalar repoOwner/repoName. Populated by the
   * session list index (SessionEntry.repositories).
   */
  repositories?: SessionListRepository[];
  /**
   * The environment this session was launched from (provenance), or null.
   * Populated by the session list index (SessionEntry.environmentId); PR-12
   * renders it.
   */
  environmentId?: string | null;
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

const sessionArtifactSchema = z.object({
  id: z.string(),
  type: artifactTypeSchema,
  url: z.string().nullable(),
  metadata: recordSchema.nullable(),
  createdAt: z.number(),
});

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
  sandboxEventBaseSchema.extend({
    // Emitted once when the sandbox bridge connects and OpenCode is ready.
    // Present in essentially every session's replay history.
    type: z.literal("ready"),
    opencodeSessionId: z.string().nullable().optional(),
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
    tokens: tokenUsageSchema.optional(),
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
  // Push events: repoOwner/repoName identify the member of a multi-repo
  // session (absent → the session's sole repo). branchName is optional
  // because legacy runtimes emit a key-less push_error on the
  // "no repository found" path — requiring it would drop that event at the
  // parse layer and leak the pending push resolver.
  z.object({
    type: z.literal("push_complete"),
    branchName: z.string().optional(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push_error"),
    branchName: z.string().optional(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    error: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  // Non-fatal boot/runtime warnings (secondary setup/start failures,
  // .opencode assembly collisions, secrets collisions). Live ingest drops
  // unknown union members, so this member must exist before runtimes emit it.
  z.object({
    type: z.literal("warning"),
    scope: z.enum(["sync", "setup", "start", "assembly", "secrets"]),
    message: z.string(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
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

/**
 * Sandbox event arrays for session hydration — both the initial `subscribed`
 * replay and paginated `history_page` items, which read from the same event
 * store. Resilient to unknown/legacy event shapes: each event is validated
 * individually and dropped if it doesn't match, instead of failing the whole
 * message. A single unrecognized event (e.g. a legacy type no longer in the
 * schema) must never wedge session hydration and strand the client on
 * "loading session" forever.
 */
const tolerantSandboxEventsSchema = z.array(z.unknown()).transform((events) =>
  events.flatMap((event) => {
    const result = sandboxEventSchema.safeParse(event);
    return result.success ? [result.data] : [];
  })
);

// WebSocket message types
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
  /**
   * Ordered member list; [0] = primary. Absent on scalar-era producers —
   * consumers default to [] / synthesize from repoOwner/repoName.
   */
  repositories?: SessionRepositoryState[];
  /**
   * The environment this session was launched from (provenance), or null for
   * repo-launched/ad-hoc sessions. `environmentName` is resolved live and is
   * null when the environment has since been deleted (design §7.6) — the UI
   * renders "environment deleted" in that case.
   */
  environmentId?: string | null;
  environmentName?: string | null;
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

// ==================== Repository lists (multi-repo sessions) ====================

/** Maximum repositories a session or automation can target. */
export const MAX_TARGET_REPOSITORIES = 10;

/**
 * Fully-resolved repository reference (all fields non-null). NOT an alias of
 * AutomationRepository, whose repoId/baseBranch are nullable — the relation is
 * "RepositoryRef = the resolved flavor of it": share the input schema, keep
 * both types, convert at resolution time (toRepositoryRef).
 */
export interface RepositoryRef {
  repoOwner: string;
  repoName: string;
  repoId: number;
  baseBranch: string;
}

/**
 * Per-repo session git state; position 0 = primary. Standalone rather than
 * extending RepositoryRef: repoId is nullable because legacy synthesized
 * entries (pre-feature sessions) may lack it.
 */
export const sessionRepositoryStateSchema = z.object({
  position: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  repoId: z.number().nullable(),
  baseBranch: z.string(),
  /** Set after the first successful push to this repo. */
  branchName: z.string().nullable(),
  baseSha: z.string().nullable(),
  currentSha: z.string().nullable(),
  /** Latest PR artifact for this repo (convenience mirror). */
  prUrl: z.string().nullable(),
});

export type SessionRepositoryState = z.infer<typeof sessionRepositoryStateSchema>;

/**
 * A session's repository-set member as carried on the session list contract
 * (Session.repositories / control-plane SessionEntry.repositories). The
 * identity subset of SessionRepositoryState — no git state, since the list
 * index doesn't store it. Ordered; [0] = primary (mirrored into the scalar
 * repoOwner/repoName columns). Control-plane's SessionIndexRepository aliases
 * this so the wire shape has a single home.
 */
export interface SessionListRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

/**
 * Whether a PR artifact belongs to a given session member. Artifacts written
 * before multi-repo support carry no repo identity (`artifactRepo === null`)
 * and by construction belong to the session's primary. Identity is compared
 * case-insensitively, matching repo-identity comparison elsewhere. This is the
 * single home of that convention — the control-plane per-repo prUrl projection
 * (findPrArtifactForRepo) and the web per-repo PR chips both go through here.
 */
export function prArtifactBelongsToRepo(
  artifactRepo: { repoOwner: string; repoName: string } | null,
  targetRepo: { repoOwner: string; repoName: string },
  targetIsPrimary: boolean
): boolean {
  if (!artifactRepo) return targetIsPrimary;
  return (
    artifactRepo.repoOwner.toLowerCase() === targetRepo.repoOwner.toLowerCase() &&
    artifactRepo.repoName.toLowerCase() === targetRepo.repoName.toLowerCase()
  );
}

/**
 * One repository entry on a create/update request. Identifiers are normalized
 * (trim + lowercase) by the schema, matching normalizeOptionalRepositoryPair —
 * the list-entry twin of that scalar helper.
 */
export const repositoryInputSchema = z
  .object({
    repoOwner: z.string().trim().min(1),
    repoName: z.string().trim().min(1),
    baseBranch: z.string().trim().min(1).nullish(),
  })
  .transform((entry) => ({
    repoOwner: entry.repoOwner.toLowerCase(),
    repoName: entry.repoName.toLowerCase(),
    baseBranch: entry.baseBranch ?? null,
  }));

export type RepositoryInput = z.input<typeof repositoryInputSchema>;

/** Repository list for create/update requests: bounded and duplicate-free. */
export const repositoriesInputSchema = z
  .array(repositoryInputSchema)
  .max(MAX_TARGET_REPOSITORIES, {
    message: `repositories must contain at most ${MAX_TARGET_REPOSITORIES} entries`,
  })
  .superRefine((repositories, ctx) => {
    const seen = new Set<string>();
    repositories.forEach((repository, index) => {
      const key = `${repository.repoOwner}/${repository.repoName}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository: ${key}`,
          path: [index],
        });
      }
      seen.add(key);
    });
  });

/**
 * Session flavor of the list: additionally rejects empty lists (the field is
 * either absent — scalar-era request — or names at least one member, so an
 * empty array never masquerades as a third mode) and duplicate repoName
 * across different owners — clone paths are /workspace/{repoName}, and a
 * clear 400 beats path disambiguation.
 */
export const sessionRepositoriesInputSchema = repositoriesInputSchema.superRefine(
  (repositories, ctx) => {
    if (repositories.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repositories must contain at least one entry (omit the field instead)",
      });
    }
    const seenNames = new Set<string>();
    repositories.forEach((repository, index) => {
      if (seenNames.has(repository.repoName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository name: ${repository.repoName} (checkout paths are /workspace/{repoName})`,
          path: [index],
        });
      }
      seenNames.add(repository.repoName);
    });
  }
);

const sessionStateSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  branchName: z.string().nullable(),
  status: sessionStatusSchema,
  sandboxStatus: sandboxStatusSchema,
  messageCount: z.number(),
  createdAt: z.number(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  isProcessing: z.boolean().optional(),
  parentSessionId: z.string().nullable().optional(),
  totalCost: z.number().optional(),
  codeServerUrl: z.string().nullable().optional(),
  codeServerPassword: z.string().nullable().optional(),
  tunnelUrls: z.record(z.string(), z.string()).nullable().optional(),
  ttydUrl: z.string().nullable().optional(),
  ttydToken: z.string().nullable().optional(),
  sandboxDashboardUrl: z.string().nullable().optional(),
  /**
   * Ordered member list; [0] = primary. Optional so pre-feature servers and
   * producers stay valid — consumers default to [] (absent ≙ scalar-era
   * session; synthesize from repoOwner/repoName when rendering).
   */
  repositories: z.array(sessionRepositoryStateSchema).optional(),
  // Environment provenance (design §7.6). environmentName resolves live —
  // null when the environment was deleted after launch.
  environmentId: z.string().nullable().optional(),
  environmentName: z.string().nullable().optional(),
});

const participantPresenceSchema = z.object({
  participantId: z.string(),
  userId: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  status: z.enum(["active", "idle", "away"]),
  lastSeen: z.number(),
});

const participantSummarySchema = z.object({
  participantId: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
});

const historyCursorSchema = z.object({ timestamp: z.number(), id: z.string() });

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong"), timestamp: z.number() }),
  z.object({
    type: z.literal("subscribed"),
    sessionId: z.string(),
    state: sessionStateSchema,
    artifacts: z.array(sessionArtifactSchema),
    participantId: z.string(),
    participant: participantSummarySchema.optional(),
    replay: z
      .object({
        events: tolerantSandboxEventsSchema,
        hasMore: z.boolean(),
        cursor: historyCursorSchema.nullable(),
      })
      .optional(),
    spawnError: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("prompt_queued"), messageId: z.string(), position: z.number() }),
  z.object({ type: z.literal("sandbox_event"), event: sandboxEventSchema }),
  z.object({ type: z.literal("presence_sync"), participants: z.array(participantPresenceSchema) }),
  z.object({
    type: z.literal("presence_update"),
    participants: z.array(participantPresenceSchema),
  }),
  z.object({ type: z.literal("presence_leave"), userId: z.string() }),
  z.object({ type: z.literal("sandbox_warming") }),
  z.object({ type: z.literal("sandbox_spawning") }),
  z.object({ type: z.literal("sandbox_status"), status: sandboxStatusSchema }),
  z.object({ type: z.literal("sandbox_ready") }),
  z.object({ type: z.literal("sandbox_error"), error: z.string() }),
  z.object({ type: z.literal("artifact_created"), artifact: sessionArtifactSchema }),
  // repoOwner/repoName identify the member of a multi-repo session whose
  // branch updated (absent → the session's sole repo).
  z.object({
    type: z.literal("session_branch"),
    branchName: z.string(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
  }),
  z.object({ type: z.literal("snapshot_saved"), imageId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("sandbox_restored"), message: z.string() }),
  z.object({ type: z.literal("sandbox_warning"), message: z.string() }),
  z.object({ type: z.literal("processing_status"), isProcessing: z.boolean() }),
  z.object({
    type: z.literal("history_page"),
    items: tolerantSandboxEventsSchema,
    hasMore: z.boolean(),
    cursor: historyCursorSchema.nullable(),
  }),
  z.object({ type: z.literal("session_status"), status: sessionStatusSchema }),
  z.object({ type: z.literal("session_title"), title: z.string() }),
  z.object({
    type: z.literal("child_session_update"),
    childSessionId: z.string(),
    status: sessionStatusSchema,
    title: z.string().nullable(),
  }),
  z.object({ type: z.literal("code_server_info"), url: z.string(), password: z.string() }),
  z.object({ type: z.literal("ttyd_info"), url: z.string(), token: z.string() }),
  z.object({ type: z.literal("tunnel_urls"), urls: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("sandbox_dashboard_url"), url: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

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

interface CreateSessionRepositoryFields {
  repoOwner?: string | null;
  repoName?: string | null;
  branch?: string;
}

function hasMatchingRepositoryIdentifiers(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) === hasRepositoryIdentifier(data.repoName);
}

function hasRepositoryForBranch(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) || !data.branch?.trim();
}

function hasScalarRepositoryTarget(data: CreateSessionRepositoryFields): boolean {
  return (
    hasRepositoryIdentifier(data.repoOwner) ||
    hasRepositoryIdentifier(data.repoName) ||
    Boolean(data.branch?.trim())
  );
}

function hasExclusiveSessionTarget(
  data: CreateSessionRepositoryFields & {
    repositories?: unknown[] | null;
    environmentId?: string | null;
  }
): boolean {
  // At most one target mode may be selected: a named environment
  // (environmentId), an ad-hoc repository list (repositories), or the scalar
  // repoOwner/repoName/branch form. Presence-based, not length-based: any
  // provided array selects the list mode (sessionRepositoriesInputSchema
  // separately rejects empty lists, so [] can never smuggle another mode
  // through).
  const activeModes = [
    Boolean(data.repositories),
    hasRepositoryIdentifier(data.environmentId),
    hasScalarRepositoryTarget(data),
  ].filter(Boolean).length;
  return activeModes <= 1;
}

// API response types
const createSessionRequestBaseSchema = z.object({
  repoOwner: z.string().trim().min(1).nullish(),
  repoName: z.string().trim().min(1).nullish(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  /**
   * Ordered member list for multi-repo sessions ([0] = primary). Mutually
   * exclusive with the scalar repoOwner/repoName/branch fields and environmentId.
   */
  repositories: sessionRepositoriesInputSchema.optional(),
  /**
   * Launch from a named environment: its snapshotted repositories become the
   * session's members and sessions.environment_id records provenance (design
   * §5.5/§7.6). Mutually exclusive with repositories and the scalar fields.
   */
  environmentId: z.string().trim().min(1).nullish(),
});

export const createSessionRequestSchema = createSessionRequestBaseSchema
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionInputSchema = createSessionRequestBaseSchema
  .extend({
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
  })
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const createMediaArtifactRequestSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  objectKey: z.string(),
  metadata: recordSchema.optional(),
});

export type CreateMediaArtifactRequest = z.infer<typeof createMediaArtifactRequestSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  status: sessionStatusSchema,
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sendPromptResponseSchema = z.object({
  messageId: z.string().min(1),
  status: z.literal("queued").optional(),
});

export type SendPromptResponse = z.infer<typeof sendPromptResponseSchema>;

export interface ListSessionsResponse {
  sessions: Session[];
  cursor?: string;
  hasMore: boolean;
}

// --- Agent-spawned sub-sessions ---

/** Request body for POST /sessions/:parentId/children */
export const spawnChildSessionRequestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type SpawnChildSessionRequest = z.infer<typeof spawnChildSessionRequestSchema>;

/**
 * Returned by parent DO's GET /internal/spawn-context.
 *
 * Deliberately scalar in v1: child sessions inherit — and are restricted
 * to — the parent's PRIMARY repository, even for multi-repo parents (the
 * spawn route validates against the scalar mirror). Letting children target
 * other members requires spawnContext.repositories, a named fast-follow
 * (design §13.13), not a v1 promise.
 */
export const spawnContextSchema = z.object({
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  repoId: z.number().nullable(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  baseBranch: z.string().nullable(),
  owner: z.object({
    userId: z.string(),
    scmUserId: z.string().nullable(),
    scmLogin: z.string().nullable(),
    scmName: z.string().nullable(),
    scmEmail: z.string().nullable(),
    scmAccessTokenEncrypted: z.string().nullable(),
    scmRefreshTokenEncrypted: z.string().nullable(),
    scmTokenExpiresAt: z.number().nullable(),
  }),
});

export type SpawnContext = z.infer<typeof spawnContextSchema>;

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

/** Maximum repositories an automation can fan out across per invocation. */
export const MAX_AUTOMATION_REPOSITORIES = MAX_TARGET_REPOSITORIES;
/** Maximum repositories a session can target (alias of MAX_TARGET_REPOSITORIES). */
export const MAX_SESSION_REPOSITORIES = MAX_TARGET_REPOSITORIES;

export interface RepositoryPair {
  repoOwner: string;
  repoName: string;
}

export class RepositoryPairValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryPairValidationError";
  }
}

/**
 * Normalize an optional repository pair: trim + lowercase identifiers, map a
 * blank pair to null. The single write-side normalization for scalar repo
 * pairs — routes, stores, and resolvers must not roll their own.
 *
 * @throws RepositoryPairValidationError when only one identifier is present.
 */
export function normalizeOptionalRepositoryPair(
  input: { repoOwner?: string | null; repoName?: string | null },
  partialMessage = "repoOwner and repoName must be provided together"
): RepositoryPair | null {
  const repoOwner = input.repoOwner?.trim().toLowerCase() || null;
  const repoName = input.repoName?.trim().toLowerCase() || null;

  if ((repoOwner === null) !== (repoName === null)) {
    throw new RepositoryPairValidationError(partialMessage);
  }

  return repoOwner && repoName ? { repoOwner, repoName } : null;
}

/** A repository selected on an automation (response shape, resolved). */
export interface AutomationRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string | null;
}

/**
 * Convert a resolved automation-shaped repository into a RepositoryRef.
 * Throws when repoId is missing — refs are the fully-resolved flavor.
 */
export function toRepositoryRef(
  repo: AutomationRepository,
  fallbackBaseBranch = "main"
): RepositoryRef {
  if (repo.repoId == null) {
    throw new Error(`repository ${repo.repoOwner}/${repo.repoName} is not resolved (no repoId)`);
  }
  return {
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    repoId: repo.repoId,
    baseBranch: repo.baseBranch ?? fallbackBaseBranch,
  };
}

// Aliases: the input schemas are target-agnostic (defined with the repository
// list contracts above); existing automation imports keep working.
export const automationRepositoryInputSchema = repositoryInputSchema;
export type AutomationRepositoryInput = RepositoryInput;
export const automationRepositoriesInputSchema = repositoriesInputSchema;

// ==================== Environments ====================

/** Maximum characters in an environment's display name. */
export const MAX_ENVIRONMENT_NAME_LENGTH = 200;
/** Maximum characters in an environment's description. */
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 2000;

/**
 * Shape check for stable environment ids (`env_` + generated suffix). Loose on
 * the suffix alphabet — ids are opaque and the generator may change — while
 * rejecting obviously-wrong values like display names or "owner/name" pairs.
 * The single stance on id shape: everything that gates on "is this an
 * environment id" (e.g. routing-rule validation) goes through this.
 */
export function isEnvironmentId(value: string): boolean {
  return /^env_[A-Za-z0-9_-]+$/.test(value);
}

/**
 * An environment's repositories share the session list contract: non-empty,
 * deduplicated by owner/name AND by repoName (checkout paths are
 * /workspace/{repoName}, so a name collision is rejected), and capped at
 * MAX_TARGET_REPOSITORIES. An environment is a prebuildable repository set, so
 * it inherits exactly the session's list rules.
 */
export const environmentRepositoriesInputSchema = sessionRepositoriesInputSchema;

export const createEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_ENVIRONMENT_NAME_LENGTH),
  description: z.string().trim().max(MAX_ENVIRONMENT_DESCRIPTION_LENGTH).nullish(),
  prebuildEnabled: z.boolean().optional(),
  repositories: environmentRepositoriesInputSchema,
});

export const updateEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_ENVIRONMENT_NAME_LENGTH).optional(),
  description: z.string().trim().max(MAX_ENVIRONMENT_DESCRIPTION_LENGTH).nullish(),
  prebuildEnabled: z.boolean().optional(),
  repositories: environmentRepositoriesInputSchema.optional(),
});

export type CreateEnvironmentInput = z.input<typeof createEnvironmentInputSchema>;
export type UpdateEnvironmentInput = z.input<typeof updateEnvironmentInputSchema>;

/**
 * A resolved environment repository. baseBranch is non-null (the DDL column is
 * NOT NULL — resolution fills the repo's default branch when the request omits
 * it); repoId is nullable to tolerate rows written before a repo resolved.
 */
export interface EnvironmentRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

/** An environment: a named, prebuildable repository set (design §7.1). */
export interface Environment {
  id: string;
  name: string;
  description: string | null;
  prebuildEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Ordered repositories; [0] is the primary (sandbox/code-server settings source). */
  repositories: EnvironmentRepository[];
}

export interface ListEnvironmentsResponse {
  environments: Environment[];
  total: number;
}

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
  /** Selected repositories (0..MAX_AUTOMATION_REPOSITORIES); the canonical repo representation. */
  repositories: AutomationRepository[];
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
  /** Repositories to run against (0..MAX_AUTOMATION_REPOSITORIES). */
  repositories?: AutomationRepositoryInput[];
}

export interface UpdateAutomationRequest {
  name?: string;
  instructions?: string;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  /** Replaces the full repository selection when present. */
  repositories?: AutomationRepositoryInput[];
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** The firing this run belongs to. Never null after the 0030 backfill. */
  invocationId: string | null;
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
  /**
   * Repository snapshot taken at firing time — history never depends on the
   * live selection. Null for repo-less runs and legacy session-less rows.
   */
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  baseBranch: string | null;
}

export interface ListAutomationsResponse {
  automations: Automation[];
  total: number;
}

export type AutomationInvocationSource = "schedule" | "manual" | "event";

/**
 * Derived from an invocation's child runs — never stored. Zero children ⇔
 * skipped; `partial_failed` means the runs finished terminal with a mix of
 * completed and failed.
 */
export type AutomationInvocationStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "partial_failed"
  | "skipped";

/** One firing of an automation: 0 runs when skipped, else one run per repository. */
export interface AutomationInvocation {
  id: string;
  automationId: string;
  status: AutomationInvocationStatus;
  source: AutomationInvocationSource;
  /** The cron slot this firing served; null for manual/event firings. */
  scheduledAt: number | null;
  /** Non-null ⇔ this firing was skipped (runs is then empty). */
  skipReason: string | null;
  createdAt: number;
  /** Latest child completion; null until all runs are terminal. */
  completedAt: number | null;
  runs: AutomationRun[];
}

export interface ListAutomationInvocationsResponse {
  invocations: AutomationInvocation[];
  /** Counts invocations (each firing is one row regardless of fan-out width). */
  total: number;
}

export * from "./integrations";
