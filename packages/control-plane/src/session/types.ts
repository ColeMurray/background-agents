/**
 * Session-specific type definitions.
 */

import { harnessIdSchema } from "@open-inspect/shared/harnesses";
import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import {
  messageStatusSchema,
  messageSourceSchema,
  sandboxStatusSchema,
  sessionStatusSchema,
  spawnSourceSchema,
  type ParticipantRole,
} from "@open-inspect/shared/types/sessions";
import { artifactTypeSchema } from "@open-inspect/shared/types/artifacts";
import type { GitPushSpec } from "../source-control";
import { z } from "zod";

// Database row types (match SQLite schema)

export class SessionStorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStorageIntegrityError";
  }
}

export type PromptGitIdentity =
  | {
      mode: "attributed-user";
      name: string;
      email: string;
    }
  | { mode: "agent-only" };

export const sessionRowSchema = z.object({
  id: z.string(),
  session_name: z.string().nullable(), // External session name for WebSocket routing
  title: z.string().nullable(),
  repo_owner: z.string().nullable(),
  repo_name: z.string().nullable(),
  repo_id: z.number().nullable(),
  base_branch: z.string().nullable(),
  branch_name: z.string().nullable(),
  base_sha: z.string().nullable(),
  current_sha: z.string().nullable(),
  agent_session_id: z.string().nullable(), // The agent's own conversation id
  harness: harnessIdSchema, // Agent harness the session runs on; fixed at create
  model: z.string(), // LLM model to use (e.g., "anthropic/claude-haiku-4-5")
  reasoning_effort: z.string().nullable(), // Reasoning effort level (e.g., "high", "max")
  status: sessionStatusSchema,
  status_revision: z.number(),
  parent_session_id: z.string().nullable(),
  spawn_source: spawnSourceSchema,
  spawn_depth: z.number(),
  code_server_enabled: z.number(), // 0 = disabled (default), 1 = enabled
  vnc_enabled: z.number(), // 0 = disabled (default), 1 = enabled
  total_cost: z.number(), // Running aggregate of step_finish event costs
  sandbox_settings: z.string().nullable(), // JSON blob of SandboxSettings
  max_cost_usd: z.number().nullable(), // Mutable effective session cost limit; NULL = unlimited
  budget_exhausted: z.number(), // 0 = promptable by budget, 1 = paused
  environment_id: z.string().nullable(), // Launch environment provenance; NULL for repo-launched/ad-hoc sessions
  created_at: z.number(),
  updated_at: z.number(),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;

export type RepositorySessionRow = SessionRow & {
  repo_owner: string;
  repo_name: string;
};

/**
 * One member repository row, in position order (position 0 = primary).
 */
export const sessionRepositoryRowSchema = z.object({
  position: z.number(),
  repo_owner: z.string(),
  repo_name: z.string(),
  repo_id: z.number().nullable(),
  base_branch: z.string(),
  branch_name: z.string().nullable(),
  base_sha: z.string().nullable(),
  current_sha: z.string().nullable(),
});

export type SessionRepositoryRow = z.infer<typeof sessionRepositoryRowSchema>;

export function sessionHasRepository(session: SessionRow): session is RepositorySessionRow {
  return Boolean(session.repo_owner && session.repo_name);
}

const participantRoleSchema = z.enum(["owner", "member"]) satisfies z.ZodType<ParticipantRole>;

export const participantRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  canonical_user_id: z.string().nullable().optional(),
  scm_user_id: z.string().nullable(),
  scm_login: z.string().nullable(),
  scm_email: z.string().nullable(),
  scm_name: z.string().nullable(),
  auth_name: z.string().nullable(),
  role: participantRoleSchema,
  scm_access_token_encrypted: z.string().nullable(),
  scm_refresh_token_encrypted: z.string().nullable(),
  scm_token_expires_at: z.number().nullable(),
  ws_auth_token: z.string().nullable(), // SHA-256 hash of WebSocket auth token
  ws_token_created_at: z.number().nullable(), // When the token was generated
  joined_at: z.number(),
});

export type ParticipantRow = z.infer<typeof participantRowSchema>;

export const messageRowSchema = z.object({
  id: z.string(),
  author_id: z.string(),
  content: z.string(),
  source: messageSourceSchema,
  model: z.string().nullable(), // LLM model for per-message override
  reasoning_effort: z.string().nullable(), // Reasoning effort for per-message override
  attachments: z.string().nullable(), // JSON
  callback_context: z.string().nullable(), // JSON: { channel, threadTs, repoFullName, model }
  client_request_id: z.string().nullable(),
  request_fingerprint: z.string().nullable(),
  autofix_feedback_key: z.string().nullable(),
  autofix_pr_key: z.string().nullable(),
  origin_context: z.string().nullable(),
  status: messageStatusSchema,
  error_message: z.string().nullable(),
  stop_confirmation_deadline: z.number().nullable(),
  reported_cost_usd: z.number(),
  created_at: z.number(),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
});

export type MessageRow = z.infer<typeof messageRowSchema>;

export const sessionAttachmentRowSchema = z.object({
  id: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  object_key: z.string(),
  message_id: z.string().nullable(), // Set once a prompt references this upload
  cleanup_claimed_at: z.number().nullable(), // Retained until object deletion is acknowledged
  created_at: z.number(),
});

export type SessionAttachmentRow = z.infer<typeof sessionAttachmentRowSchema>;

export const eventRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.string(), // JSON
  message_id: z.string().nullable(),
  created_at: z.number(),
  timeline_sequence: z.number().optional(),
});

export type EventRow = z.infer<typeof eventRowSchema>;

export const artifactRowSchema = z.object({
  id: z.string(),
  type: artifactTypeSchema,
  url: z.string().nullable(),
  metadata: z.string().nullable(), // JSON
  created_at: z.number(),
  /** Last content change; migration 34 backfills it to created_at. */
  updated_at: z.number(),
});

export type ArtifactRow = z.infer<typeof artifactRowSchema>;

const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);

export const sandboxRowSchema = z.object({
  id: z.string(),
  modal_sandbox_id: z.string().nullable(), // Our generated sandbox ID
  modal_object_id: z.string().nullable(), // Legacy column: provider object ID (Modal object ID or Daytona handle)
  snapshot_id: z.string().nullable(),
  snapshot_image_id: z.string().nullable(), // Modal Image ID for filesystem snapshot restoration
  snapshot_runtime_version: z.string().nullable(), // SANDBOX_VERSION that produced snapshot_image_id
  runtime_version: z.string().nullable(), // SANDBOX_VERSION reported by the running sandbox
  auth_token: z.string().nullable(),
  auth_token_hash: z.string().nullable(), // SHA-256 hash of sandbox auth token
  status: sandboxStatusSchema,
  git_sync_status: gitSyncStatusSchema,
  last_heartbeat: z.number().nullable(),
  last_activity: z.number().nullable(), // Last activity timestamp for inactivity-based snapshot
  last_spawn_error: z.string().nullable(),
  last_spawn_error_at: z.number().nullable(),
  code_server_url: z.string().nullable(),
  code_server_password: z.string().nullable(),
  vnc_url: z.string().nullable(),
  vnc_password: z.string().nullable(),
  tunnel_urls: z.string().nullable(), // JSON mapping of port -> tunnel URL
  ttyd_url: z.string().nullable(),
  ttyd_token: z.string().nullable(),
  /**
   * The `socket:<id>` tag of the bridge socket the session dispatches to;
   * `''` once revoked, NULL only on rows that predate persisted identities.
   */
  active_socket_id: z.string().nullable(),
  /** JSON `SandboxBootPhase` the runtime last reported while booting; NULL once ready. */
  boot_phase: z.string().nullable(),
  /** Sequence number of that report, so a resend after a reconnect is recognised. */
  boot_seq: z.number().nullable(),
  /**
   * 1 once the boot budget revoked this generation's credentials for good: a
   * fenced row can never become ready, so a runtime that outlived its budget
   * cannot self-heal the way a watchdog-failed one may.
   */
  fenced: z.number(),
  created_at: z.number(),
});

export type SandboxRow = z.infer<typeof sandboxRowSchema>;

/**
 * The sandbox access artifacts that pair a URL with an encrypted secret:
 * code-server and VNC carry passwords, ttyd carries a minted JWT. Tunnel URLs
 * are not a kind — they are a single JSON column with no secret.
 */
export type SandboxAccessKind = "codeServer" | "vnc" | "ttyd";

// Command types for sandbox communication

interface PromptCommand {
  type: "prompt";
  messageId: string;
  content: string;
  model?: string; // LLM model for per-message override
  reasoningEffort?: string; // Reasoning effort level
  author: {
    userId: string;
    gitIdentity: PromptGitIdentity;
  };
  attachments?: ResolvedSessionAttachment[];
}

interface StopCommand {
  type: "stop";
}

interface SnapshotCommand {
  type: "snapshot";
}

interface ShutdownCommand {
  type: "shutdown";
}

interface AckCommand {
  type: "ack";
  ackId: string;
}

interface PushCommand {
  type: "push";
  pushSpec: GitPushSpec;
}

interface RefreshDiffCommand {
  type: "refresh_diff";
}

export type SandboxCommand =
  | { type: "sandbox_generation"; generation: { sandboxId: string; createdAt: number } }
  | {
      type: "prepare_preservation";
      operationId: string;
      generation: { sandboxId: string; createdAt: number };
      messageId?: string;
      stopByMs: number;
    }
  | PromptCommand
  | StopCommand
  | SnapshotCommand
  | ShutdownCommand
  | AckCommand
  | PushCommand
  | RefreshDiffCommand;
