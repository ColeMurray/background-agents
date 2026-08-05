import { z } from "zod";
import type { ResolvedSessionAttachment } from "./session-attachments";
import type { SessionListRepository } from "./repositories";

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

export const sandboxStatusSchema = z.enum([
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

export type MessageStatus = "pending" | "processing" | "completed" | "failed";

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

export type SpawnSource =
  | "user"
  | "agent"
  | "automation"
  | "github-bot"
  | "linear-bot"
  | "slack-bot";

export interface SessionParticipant {
  id: string;
  userId: string;
  scmLogin: string | null;
  scmName: string | null;
  scmEmail: string | null;
  role: ParticipantRole;
}

/**
 * Aggregate PR counts for a session, grouped by display status. Computed from
 * the D1 session_pull_requests table for the session list; total = open +
 * draft + merged + closed.
 */
export interface PullRequestSummary {
  total: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
}

export type SessionReadState =
  | {
      latestMessageId: null;
      unread: false;
    }
  | {
      latestMessageId: string;
      unread: boolean;
    };

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

export const sessionReadResultSchema = z.union([
  z
    .object({
      sessionId: z.string(),
      outcome: z.literal("no_terminal_message"),
      unread: z.literal(false),
      latestMessageId: z.null(),
    })
    .strict(),
  z
    .object({
      sessionId: z.string(),
      outcome: z.enum(["marked_read", "already_read", "not_latest"]),
      unread: z.boolean(),
      latestMessageId: z.string(),
    })
    .strict(),
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
  opencodeSessionId: string | null;
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

export interface SessionMessage {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  attachments: ResolvedSessionAttachment[] | null;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

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
