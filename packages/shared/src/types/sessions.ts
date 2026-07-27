import { z } from "zod";
import type { ResolvedSessionAttachment } from "./session-attachments";
import {
  sandboxStatusSchema,
  sessionStatusSchema,
  type MessageSource,
  type MessageStatus,
  type ParticipantRole,
  type SandboxStatus,
  type SessionStatus,
  type SpawnSource,
} from "./statuses";
import {
  sessionRepositoryStateSchema,
  type SessionListRepository,
  type SessionRepositoryState,
} from "./repositories";

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
   * Ordered repository list; [0] = primary. Absent on scalar-era producers —
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

export interface ParticipantPresence {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

/** Internal runtime schema used by the server-message protocol. */
export const sessionStateSchema = z.object({
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
   * Ordered repository list; [0] = primary. Optional so pre-feature servers
   * and producers stay valid — consumers default to [] (absent means a
   * scalar-era session; synthesize from repoOwner/repoName when rendering).
   */
  repositories: z.array(sessionRepositoryStateSchema).optional(),
  // Environment provenance (design §7.6). environmentName resolves live —
  // null when the environment was deleted after launch.
  environmentId: z.string().nullable().optional(),
  environmentName: z.string().nullable().optional(),
});

/** Internal runtime schema used by the server-message protocol. */
export const participantPresenceSchema = z.object({
  participantId: z.string(),
  userId: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  status: z.enum(["active", "idle", "away"]),
  lastSeen: z.number(),
});
