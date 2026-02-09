/**
 * Type definitions for Open-Inspect Control Plane.
 *
 * Platform-agnostic types. All Cloudflare-specific bindings have been removed.
 */

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

// Client -> Server messages
export type ClientMessage =
  | { type: "ping" }
  | { type: "subscribe"; token: string; clientId: string }
  | {
      type: "prompt";
      content: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: Attachment[];
    }
  | { type: "stop" }
  | { type: "typing" }
  | {
      type: "presence";
      status: "active" | "idle";
      cursor?: { line: number; file: string };
    }
  | { type: "fetch_history"; cursor: { timestamp: number; id: string }; limit?: number };

// Server -> Client messages
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
  | { type: "processing_status"; isProcessing: boolean }
  | {
      type: "replay_complete";
      hasMore: boolean;
      cursor: { timestamp: number; id: string } | null;
    }
  | {
      type: "history_page";
      items: SandboxEvent[];
      hasMore: boolean;
      cursor: { timestamp: number; id: string } | null;
    };

// Sandbox events (from sandbox pods)
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
      type: "error";
      error: string;
      messageId: string;
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
    }
  | {
      type: "user_message";
      content: string;
      messageId: string;
      timestamp: number;
      author?: { participantId: string; name: string; avatar?: string };
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
  reasoningEffort?: string;
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

// API response types
export interface CreateSessionRequest {
  repoOwner: string;
  repoName: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
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
  total: number;
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
