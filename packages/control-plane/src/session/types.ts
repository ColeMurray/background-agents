/**
 * Session-specific type definitions.
 */

import type {
  Attachment,
  SessionStatus,
  SandboxStatus,
  GitSyncStatus,
  MessageStatus,
  MessageSource,
  ParticipantRole,
  SpawnSource,
  ArtifactType,
  EventType,
  PlanApprovalStatus,
} from "../types";
import type { PlanSource } from "@open-inspect/shared";
import type { GitPushSpec } from "../source-control";

export type { PlanSource };

// Database row types (match SQLite schema)

export interface SessionRow {
  id: string;
  session_name: string | null; // External session name for WebSocket routing
  title: string | null;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
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
  total_cost: number; // Running aggregate of step_finish event costs
  sandbox_settings: string | null; // JSON blob of SandboxSettings
  plan_mode: number; // 0 = normal, 1 = plan-first HITL session (immuable post-creation)
  plan_approval_status: PlanApprovalStatus | null;
  plan_model: string | null; // Model used for planning turns (NULL when plan_mode=0)
  plan_cost_snapshot: number | null; // total_cost captured at plan approval; NULL until then
  created_at: number;
  updated_at: number;
}

export interface ParticipantRow {
  id: string;
  user_id: string;
  scm_user_id: string | null;
  scm_login: string | null;
  scm_email: string | null;
  scm_name: string | null;
  role: ParticipantRole;
  scm_access_token_encrypted: string | null;
  scm_refresh_token_encrypted: string | null;
  scm_token_expires_at: number | null;
  ws_auth_token: string | null; // SHA-256 hash of WebSocket auth token
  ws_token_created_at: number | null; // When the token was generated
  joined_at: number;
}

export interface MessageRow {
  id: string;
  author_id: string;
  content: string;
  source: MessageSource;
  model: string | null; // LLM model for per-message override
  reasoning_effort: string | null; // Reasoning effort for per-message override
  attachments: string | null; // JSON
  callback_context: string | null; // JSON: { channel, threadTs, repoFullName, model }
  status: MessageStatus;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface EventRow {
  id: string;
  type: EventType;
  data: string; // JSON
  message_id: string | null;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: string | null; // JSON
  created_at: number;
}

export interface PlanRow {
  id: string;
  version: number;
  content: string;
  created_by_author_id: string | null;
  created_by_message_id: string | null;
  source: PlanSource;
  created_at: number;
}

export interface SandboxRow {
  id: string;
  modal_sandbox_id: string | null; // Our generated sandbox ID
  modal_object_id: string | null; // Legacy column: provider object ID (Modal object ID or Daytona handle)
  snapshot_id: string | null;
  snapshot_image_id: string | null; // Modal Image ID for filesystem snapshot restoration
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
  tunnel_urls: string | null; // JSON mapping of port -> tunnel URL
  ttyd_url: string | null;
  ttyd_token: string | null;
  created_at: number;
}

// Command types for sandbox communication

export interface PromptResumeContext {
  /** Plan content at the time this prompt was dispatched, if any plan is saved. */
  currentPlan: {
    version: number;
    content: string;
    createdAt: number;
  };
}

export interface PromptCommand {
  type: "prompt";
  messageId: string;
  content: string;
  model?: string; // LLM model for per-message override
  reasoningEffort?: string; // Reasoning effort level
  author: {
    userId: string;
    scmName: string | null;
    scmEmail: string | null;
  };
  attachments?: Attachment[];
  /**
   * Resume context attached when a saved plan exists. Sandbox behavior depends on
   * `planMode`:
   *   - planMode === true: use the previous plan as a base to amend during this
   *     planning turn (read-only tools + save_plan).
   *   - planMode === false: prepend a restate-and-confirm instruction so the
   *     agent re-anchors on the approved plan before any destructive action.
   */
  resumeContext?: PromptResumeContext;
  /**
   * True when this prompt is a planning turn (session is plan-mode and the
   * current plan has not been approved). The bridge must restrict tools to
   * read-only + save_plan and surface a planning-specific preamble.
   */
  planMode?: boolean;
}

export interface StopCommand {
  type: "stop";
}

export interface SnapshotCommand {
  type: "snapshot";
}

export interface ShutdownCommand {
  type: "shutdown";
}

export interface AckCommand {
  type: "ack";
  ackId: string;
}

export interface PushCommand {
  type: "push";
  pushSpec: GitPushSpec;
}

export type SandboxCommand =
  | PromptCommand
  | StopCommand
  | SnapshotCommand
  | ShutdownCommand
  | AckCommand
  | PushCommand;

// Internal session update types

export interface SessionUpdate {
  title?: string;
  branchName?: string;
  baseSha?: string;
  currentSha?: string;
  opencodeSessionId?: string;
  status?: SessionStatus;
}

export interface SandboxUpdate {
  modalSandboxId?: string;
  snapshotId?: string;
  status?: SandboxStatus;
  gitSyncStatus?: GitSyncStatus;
}
