/**
 * Session-specific type definitions.
 */

import type {
  SessionStatus,
  SandboxStatus,
  GitSyncStatus,
  MessageStatus,
  MessageSource,
  ParticipantRole,
  ArtifactType,
  EventType,
} from "../types";

// Database row types (match SQLite schema)

export interface SessionRow {
  id: string;
  session_name: string | null; // External session name for WebSocket routing
  title: string | null;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  repo_default_branch: string;
  branch_name: string | null;
  base_sha: string | null;
  current_sha: string | null;
  opencode_session_id: string | null;
  model: string; // LLM model to use (e.g., "claude-haiku-4-5")
  status: SessionStatus;
  created_at: number;
  updated_at: number;
}

export interface ParticipantRow {
  id: string;
  user_id: string;
  github_user_id: string | null;
  github_login: string | null;
  github_email: string | null;
  github_name: string | null;
  role: ParticipantRole;
  github_access_token_encrypted: string | null;
  github_refresh_token_encrypted: string | null;
  github_token_expires_at: number | null;
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

export interface SandboxRow {
  id: string;
  modal_sandbox_id: string | null; // Our generated sandbox ID
  modal_object_id: string | null; // Modal's internal object ID (for snapshot API)
  snapshot_id: string | null;
  snapshot_image_id: string | null; // Modal Image ID for filesystem snapshot restoration
  auth_token: string | null;
  status: SandboxStatus;
  git_sync_status: GitSyncStatus;
  last_heartbeat: number | null;
  last_activity: number | null; // Last activity timestamp for inactivity-based snapshot
  last_spawn_error: string | null;
  last_spawn_error_at: number | null;
  created_at: number;
}

// Command types for sandbox communication

export interface PromptCommand {
  type: "prompt";
  messageId: string;
  content: string;
  model?: string; // LLM model for per-message override
  author: {
    userId: string;
    githubName: string | null;
    githubEmail: string | null;
  };
  attachments?: Array<{
    type: string;
    name: string;
    url?: string;
    content?: string;
  }>;
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

export type SandboxCommand = PromptCommand | StopCommand | SnapshotCommand | ShutdownCommand;

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
