import { harnessIdSchema, type HarnessId } from "../harnesses";
import { z } from "zod";
import { resolvedSessionAttachmentsSchema } from "./session-attachments";
import { sessionListRepositorySchema, type SessionListRepository } from "./repositories";

/**
 * A session's conversation lifecycle: durable, user-visible, and independent
 * of whether any compute is currently attached. See `SandboxStatus` for the
 * compute side; the two are at different levels and share no vocabulary.
 */
export const sessionStatusSchema = z.enum([
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * The state of a session's CURRENT sandbox incarnation.
 *
 * A session has many incarnations over its lifetime, so this never describes
 * the session itself — see `SessionStatus` for that. A session may be
 * `completed` with a live sandbox attached, or `active` with none at all. Do
 * not render this as the session's status: doing so is what let the sidebar
 * and the header disagree about the same session.
 *
 * Every member here must be producible by some code path. `syncing` and
 * `running` were removed because nothing in any language ever wrote them;
 * `warming` is kept because, although it is never persisted, the web client
 * sets it optimistically on the `sandbox_warming` message and Modal reports
 * it from its own manager.
 */
export const sandboxStatusSchema = z.enum([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "ready",
  "stale",
  "snapshotting",
  "stopped",
  "failed",
]);
export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;

export const messageStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageSourceSchema = z.enum([
  "web",
  "slack",
  "linear",
  "extension",
  "github",
  "automation",
  "agent",
]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

export type ParticipantRole = "owner" | "member";

export const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);
export type SpawnSource = z.infer<typeof spawnSourceSchema>;

/**
 * Aggregate PR counts for a session, grouped by display status. Computed from
 * the D1 session_pull_requests table for the session list; total = open +
 * draft + merged + closed.
 */
export const pullRequestSummarySchema = z.object({
  total: z.number(),
  open: z.number(),
  draft: z.number(),
  merged: z.number(),
  closed: z.number(),
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const INITIAL_SESSION_READ_STATE_VERSION = 0;

/**
 * Viewer-specific read state for a session's latest terminal message.
 *
 * `version` orders terminal messages: it is the projected creation time of
 * the latest one and 0 before any turn completes. A read state with a higher
 * version supersedes one with a lower version. Messages that share a version
 * are ordered by message ID, as the projection orders them. For one message,
 * read is final.
 */
export const sessionReadStateSchema = z.union([
  z.object({
    latestMessageId: z.null(),
    unread: z.literal(false),
    version: z.number(),
  }),
  z.object({
    latestMessageId: z.string(),
    unread: z.boolean(),
    version: z.number(),
  }),
]);
export type SessionReadState = z.infer<typeof sessionReadStateSchema>;

/** Fields shared only by the list, inbox, and direct-child response projections. */
export const sessionSummaryBaseSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  status: sessionStatusSchema,
  parentSessionId: z.string().nullable(),
  spawnSource: spawnSourceSchema,
  environmentId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  repositories: z.array(sessionListRepositorySchema).optional(),
  pullRequestSummary: pullRequestSummarySchema.optional(),
});
export type SessionSummaryBase = z.infer<typeof sessionSummaryBaseSchema>;

/** Direct-child list item. Viewer-specific read state is intentionally absent. */
export const childSessionSummarySchema = sessionSummaryBaseSchema.extend({
  harness: harnessIdSchema,
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  spawnDepth: z.number(),
  automationId: z.string().nullable(),
  automationRunId: z.string().nullable(),
  scmLogin: z.string().nullable(),
  userId: z.string().nullable(),
  totalCost: z.number(),
  activeDurationMs: z.number(),
  messageCount: z.number(),
  prCount: z.number(),
});
export type ChildSessionSummary = z.infer<typeof childSessionSummarySchema>;

export const childSessionListResponseSchema = z.object({
  children: z.array(childSessionSummarySchema),
});
export type ChildSessionListResponse = z.infer<typeof childSessionListResponseSchema>;

/** Flat session-list item. Read state is absent for callers without a viewer identity. */
export const sessionListSummarySchema = childSessionSummarySchema.extend({
  readState: sessionReadStateSchema.optional(),
});
export type SessionListSummary = z.infer<typeof sessionListSummarySchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionListSummarySchema),
  hasMore: z.boolean(),
});
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionReadActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("mark_message_read"),
      messageId: z.string().min(1),
    })
    .strict(),
  z.object({ action: z.literal("mark_latest_message_read") }).strict(),
]);
export type SessionReadAction = z.infer<typeof sessionReadActionSchema>;

// Parsed from responses, so additive server fields must not fail an older
// client. A control plane that predates `version` reads as version 0, which
// never supersedes cached state.
export const sessionReadResultSchema = z.union([
  z.object({
    sessionId: z.string(),
    outcome: z.literal("no_terminal_message"),
    unread: z.literal(false),
    latestMessageId: z.null(),
    version: z.number().default(INITIAL_SESSION_READ_STATE_VERSION),
  }),
  z.object({
    sessionId: z.string(),
    outcome: z.enum(["marked_read", "already_read", "not_latest"]),
    unread: z.boolean(),
    latestMessageId: z.string(),
    version: z.number().default(INITIAL_SESSION_READ_STATE_VERSION),
  }),
]);
export type SessionReadResult = z.infer<typeof sessionReadResultSchema>;

export interface Session {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  /** The agent's own conversation id (formerly opencodeSessionId). */
  agentSessionId: string | null;
  /** Agent harness the session runs on. */
  harness: HarnessId;
  status: SessionStatus;
  parentSessionId: string | null;
  spawnSource: SpawnSource;
  spawnDepth: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Ordered repository list; [0] = primary. Absent on scalar-era sessions —
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
  /**
   * Aggregate PR status counts for the global sidebar. Populated by the
   * session list index from session_pull_requests; absent while versions
   * overlap or when the session has no tracked PRs.
   */
  pullRequestSummary?: PullRequestSummary;
  /** Viewer-specific read state; absent for non-user service callers. */
  readState?: SessionReadState;
}

export const sessionMessageSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  content: z.string(),
  source: messageSourceSchema,
  attachments: resolvedSessionAttachmentsSchema.nullable(),
  status: messageStatusSchema,
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

export const sessionParticipantProfileSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export type SessionParticipantProfile = z.infer<typeof sessionParticipantProfileSchema>;

export const sessionParticipantProfilesResponseSchema = z.object({
  profiles: z.record(z.string(), sessionParticipantProfileSchema),
});

export type SessionParticipantProfilesResponse = z.infer<
  typeof sessionParticipantProfilesResponseSchema
>;
