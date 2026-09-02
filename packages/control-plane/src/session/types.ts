/**
 * Session-specific type definitions.
 */

import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import type {
  SessionStatus,
  SandboxStatus,
  MessageStatus,
  MessageSource,
  ParticipantRole,
  SpawnSource,
} from "@open-inspect/shared/types/sessions";
import { artifactTypeSchema } from "@open-inspect/shared/types/artifacts";
import type { EventType, GitSyncStatus } from "@open-inspect/shared/types/sandbox-events";
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

export interface SessionRow {
  id: string;
  session_name: string | null; // External session name for WebSocket routing
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_id: number | null;
  base_branch: string | null;
  branch_name: string | null;
  base_sha: string | null;
  current_sha: string | null;
  opencode_session_id: string | null;
  model: string; // LLM model to use (e.g., "anthropic/claude-haiku-4-5")
  reasoning_effort: string | null; // Reasoning effort level (e.g., "high", "max")
  status: SessionStatus;
  parent_session_id: string | null;
  spawn_source: SpawnSource;
  spawn_depth: number;
  code_server_enabled: number; // 0 = disabled (default), 1 = enabled
  vnc_enabled: number; // 0 = disabled (default), 1 = enabled
  total_cost: number; // Running aggregate of step_finish event costs
  sandbox_settings: string | null; // JSON blob of SandboxSettings
  environment_id: string | null; // Launch environment provenance; NULL for repo-launched/ad-hoc sessions
  created_at: number;
  updated_at: number;
}

export type RepositorySessionRow = SessionRow & {
  repo_owner: string;
  repo_name: string;
};

/**
 * One member repository row, in position order (position 0 = primary).
 */
export interface SessionRepositoryRow {
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
  branch_name: string | null;
  base_sha: string | null;
  current_sha: string | null;
}

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

export interface MessageRow {
  id: string;
  author_id: string;
  content: string;
  source: MessageSource;
  model: string | null; // LLM model for per-message override
  reasoning_effort: string | null; // Reasoning effort for per-message override
  attachments: string | null; // JSON
  callback_context: string | null; // JSON: { channel, threadTs, repoFullName, model }
  client_request_id: string | null;
  request_fingerprint: string | null;
  autofix_feedback_key: string | null;
  autofix_pr_key: string | null;
  origin_context: string | null;
  status: MessageStatus;
  error_message: string | null;
  stop_confirmation_deadline: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

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

export interface EventRow {
  id: string;
  type: EventType;
  data: string; // JSON
  message_id: string | null;
  created_at: number;
  timeline_sequence?: number;
}

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

export interface SandboxRow {
  id: string;
  modal_sandbox_id: string | null; // Our generated sandbox ID
  modal_object_id: string | null; // Legacy column: provider object ID (Modal object ID or Daytona handle)
  snapshot_id: string | null;
  snapshot_image_id: string | null; // Modal Image ID for filesystem snapshot restoration
  snapshot_runtime_version: string | null; // SANDBOX_VERSION that produced snapshot_image_id
  runtime_version: string | null; // SANDBOX_VERSION reported by the running sandbox
  auth_token: string | null;
  auth_token_hash: string | null; // SHA-256 hash of sandbox auth token
  status: SandboxStatus;
  git_sync_status: GitSyncStatus;
  last_heartbeat: number | null;
  last_activity: number | null; // Last activity timestamp for inactivity-based snapshot
  last_spawn_error: string | null;
  last_spawn_error_at: number | null;
  code_server_url: string | null;
  code_server_password: string | null;
  vnc_url: string | null;
  vnc_password: string | null;
  tunnel_urls: string | null; // JSON mapping of port -> tunnel URL
  ttyd_url: string | null;
  ttyd_token: string | null;
  created_at: number;
}

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
  | PromptCommand
  | StopCommand
  | SnapshotCommand
  | ShutdownCommand
  | AckCommand
  | PushCommand
  | RefreshDiffCommand;
