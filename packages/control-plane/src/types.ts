/**
 * Type definitions for Open-Inspect Control Plane.
 */

// Environment bindings
export interface Env {
  // Durable Objects
  SESSION: DurableObjectNamespace;

  // KV Namespaces
  SESSION_INDEX: KVNamespace; // Index for listing sessions

  // Service bindings
  SLACK_BOT?: Fetcher; // Optional - only if slack-bot is deployed

  // D1 database
  DB: D1Database;

  // Secrets
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY: string;
  REPO_SECRETS_ENCRYPTION_KEY?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_API_SECRET?: string; // Shared secret for authenticating with Modal endpoints
  INTERNAL_CALLBACK_SECRET?: string; // For signing callbacks to slack-bot

  // GitHub App secrets (for git operations)
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;

  // Variables
  DEPLOYMENT_NAME: string;
  WORKER_URL?: string; // Base URL for the worker (for callbacks)
  WEB_APP_URL?: string; // Base URL for the web app (for PR links)
  CF_ACCOUNT_ID?: string; // Cloudflare account ID
  MODAL_WORKSPACE?: string; // Modal workspace name (used in Modal endpoint URLs)

  // Sandbox lifecycle configuration
  SANDBOX_INACTIVITY_TIMEOUT_MS?: string; // Inactivity timeout in ms (default: 600000 = 10 min)

  // Logging
  LOG_LEVEL?: string; // "debug" | "info" | "warn" | "error" (default: "info")
}

// Session status
export type SessionStatus = "created" | "active" | "completed" | "archived";

// Sandbox status
export type SandboxStatus =
  | "pending"
  | "spawning"
  | "connecting"
  | "warming"
  | "syncing"
  | "ready"
  | "running"
  | "stale" // Heartbeat missed - sandbox may be unresponsive
  | "snapshotting" // Taking filesystem snapshot
  | "stopped"
  | "failed";

// Git sync status
export type GitSyncStatus = "pending" | "in_progress" | "completed" | "failed";

// Participant role
export type ParticipantRole = "owner" | "member";

// Message status
export type MessageStatus = "pending" | "processing" | "completed" | "failed";

// Message source
export type MessageSource = "web" | "slack" | "extension" | "github";

// Event types
export type EventType = "tool_call" | "tool_result" | "token" | "error" | "git_sync";

// Artifact types
export type ArtifactType = "pr" | "screenshot" | "preview" | "branch";

// Client → Server messages
export type ClientMessage =
  | { type: "ping" }
  | { type: "subscribe"; token: string; clientId: string }
  | { type: "prompt"; content: string; model?: string; attachments?: Attachment[] }
  | { type: "stop" }
  | { type: "typing" }
  | {
      type: "presence";
      status: "active" | "idle";
      cursor?: { line: number; file: string };
    };

// Server → Client messages
export type ServerMessage =
  | { type: "pong"; timestamp: number }
  | {
      type: "subscribed";
      sessionId: string;
      state: SessionState;
      participantId: string;
      participant?: { participantId: string; name: string; avatar?: string };
    }
  | { type: "prompt_queued"; messageId: string; position: number }
  | { type: "sandbox_event"; event: SandboxEvent }
  | { type: "presence_sync"; participants: ParticipantPresence[] }
  | { type: "presence_update"; participants: ParticipantPresence[] }
  | { type: "presence_leave"; userId: string }
  | { type: "sandbox_warming" }
  | { type: "sandbox_spawning" }
  | { type: "sandbox_status"; status: string }
  | { type: "sandbox_ready" }
  | { type: "sandbox_error"; error: string }
  | { type: "error"; code: string; message: string }
  | {
      type: "artifact_created";
      artifact: { id: string; type: string; url: string; prNumber?: number };
    }
  | { type: "snapshot_saved"; imageId: string; reason: string }
  | { type: "sandbox_restored"; message: string }
  | { type: "sandbox_warning"; message: string }
  | { type: "session_status"; status: SessionStatus }
  | { type: "processing_status"; isProcessing: boolean };

// Sandbox events (from Modal)
export type SandboxEvent =
  | { type: "heartbeat"; sandboxId: string; status: string; timestamp: number }
  | {
      type: "token";
      content: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "tool_call";
      tool: string;
      args: Record<string, unknown>;
      callId: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "tool_result";
      callId: string;
      result: string;
      error?: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "git_sync";
      status: GitSyncStatus;
      sha?: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "execution_complete";
      messageId: string;
      success: boolean;
      error?: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "artifact";
      artifactType: string;
      url: string;
      metadata?: Record<string, unknown>;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "push_complete";
      branchName: string;
      sandboxId?: string;
      timestamp?: number;
    }
  | {
      type: "push_error";
      branchName: string;
      error: string;
      sandboxId?: string;
      timestamp?: number;
    };

// Attachment
export interface Attachment {
  type: "file" | "image" | "url";
  name: string;
  url?: string;
  content?: string;
  mimeType?: string;
}

// Session state (sent to client on subscribe)
export interface SessionState {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  branchName: string | null;
  status: SessionStatus;
  sandboxStatus: SandboxStatus;
  messageCount: number;
  createdAt: number;
  model?: string;
  isProcessing: boolean;
}

// Participant presence
export interface ParticipantPresence {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

// Client info (stored in DO memory)
export interface ClientInfo {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
  clientId: string;
  ws: WebSocket;
}

// API response types
export interface CreateSessionRequest {
  repoOwner: string;
  repoName: string;
  title?: string;
  model?: string; // LLM model to use (e.g., "claude-haiku-4-5", "claude-sonnet-4-5")
}

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
}

export interface SessionResponse {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  repoDefaultBranch: string;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  opencodeSessionId: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ListSessionsResponse {
  sessions: SessionResponse[];
  cursor?: string;
  hasMore: boolean;
}

export interface MessageResponse {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
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

export interface ParticipantResponse {
  id: string;
  userId: string;
  githubLogin: string | null;
  githubName: string | null;
  role: ParticipantRole;
  joinedAt: number;
}

// GitHub OAuth types
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
}
