/**
 * Shared type definitions used across Background Agents packages.
 */

// Session states
export type SessionStatus = "created" | "active" | "completed" | "archived";
export type SandboxStatus =
  | "pending"
  | "warming"
  | "syncing"
  | "ready"
  | "running"
  | "stopped"
  | "failed";
export type GitSyncStatus = "pending" | "in_progress" | "completed" | "failed";
export type MessageStatus = "pending" | "processing" | "completed" | "failed";
export type MessageSource = "web";
export type ArtifactType = "pr" | "screenshot" | "preview" | "branch";
export type EventType = "tool_call" | "tool_result" | "token" | "error" | "git_sync";

// Session state
export interface Session {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  opencodeSessionId: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

// Message in a session
export interface SessionMessage {
  id: string;
  content: string;
  source: MessageSource;
  attachments: Attachment[] | null;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// Attachment to a message
export interface Attachment {
  type: "file" | "image" | "url";
  name: string;
  url?: string;
  content?: string;
  mimeType?: string;
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

// Pull request info
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged";
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

// Sandbox event from the coding agent
export interface SandboxEvent {
  type: string;
  sandboxId: string;
  timestamp: number;
  messageId?: string;
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  callId?: string;
  output?: string;
  result?: string;
  error?: string;
  status?: string;
  sha?: string;
  success?: boolean;
  artifactType?: string;
  url?: string;
  metadata?: Record<string, unknown>;
  author?: {
    name: string;
  };
}

// WebSocket message types
export type ClientMessage =
  | { type: "ping" }
  | { type: "subscribe" }
  | {
      type: "prompt";
      content: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: Attachment[];
    }
  | { type: "stop" }
  | { type: "typing" };

// Session state sent to clients
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
  isProcessing?: boolean;
}

// API response types
export interface CreateSessionRequest {
  repoPath: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
}

export interface ListSessionsResponse {
  sessions: Session[];
  cursor?: string;
  hasMore: boolean;
}
