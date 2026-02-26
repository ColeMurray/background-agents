/**
 * Shared type definitions used across Open-Inspect packages.
 */

// Session states
export type SessionStatus = "created" | "active" | "completed" | "archived" | "cancelled";
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
export type MessageSource = "web" | "slack" | "extension" | "github";
export type ArtifactType = "pr" | "screenshot" | "preview" | "branch";
export type EventType = "tool_call" | "tool_result" | "token" | "error" | "git_sync";

// Participant in a session
export interface SessionParticipant {
  id: string;
  userId: string;
  scmLogin: string | null;
  scmName: string | null;
  scmEmail: string | null;
  role: "owner" | "member";
}

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
  parentSessionId: string | null;
  spawnSource: "user" | "agent";
  spawnDepth: number;
  createdAt: number;
  updatedAt: number;
}

// Message in a session
export interface SessionMessage {
  id: string;
  authorId: string;
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

// Sandbox event from Modal
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
    participantId: string;
    name: string;
    avatar?: string;
  };
}

// WebSocket message types
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
  | { type: "presence"; status: "active" | "idle"; cursor?: { line: number; file: string } };

export type ServerMessage =
  | { type: "pong"; timestamp: number }
  | {
      type: "subscribed";
      sessionId: string;
      state: SessionState;
      participantId: string;
      participant?: { participantId: string; name: string; avatar?: string };
      replay?: {
        events: SandboxEvent[];
        hasMore: boolean;
        cursor: { timestamp: number; id: string } | null;
      };
      spawnError?: string | null;
    }
  | { type: "prompt_queued"; messageId: string; position: number }
  | { type: "sandbox_event"; event: SandboxEvent }
  | { type: "presence_sync"; participants: ParticipantPresence[] }
  | { type: "presence_update"; participants: ParticipantPresence[] }
  | { type: "presence_leave"; userId: string }
  | { type: "sandbox_warming" }
  | { type: "sandbox_ready" }
  | { type: "session_status"; status: SessionStatus }
  | { type: "error"; code: string; message: string };

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
  parentSessionId?: string | null;
}

// Participant presence info
export interface ParticipantPresence {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

// Repository types for GitHub App installation
export interface InstallationRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export interface RepoMetadata {
  description?: string;
  aliases?: string[];
  channelAssociations?: string[];
  keywords?: string[];
}

export interface EnrichedRepository extends InstallationRepository {
  metadata?: RepoMetadata;
}

// ─── Callback Context (discriminated union) ──────────────────────────────────

export interface SlackCallbackContext {
  source: "slack";
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  reactionMessageTs?: string;
}

export interface LinearCallbackContext {
  source: "linear";
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  repoFullName: string;
  model: string;
  agentSessionId?: string;
  organizationId?: string;
  emitToolProgressActivities?: boolean;
}

export type CallbackContext = SlackCallbackContext | LinearCallbackContext;

// API response types
export interface CreateSessionRequest {
  repoOwner: string;
  repoName: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  branch?: string;
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

// --- Agent-spawned sub-sessions ---

/** Request body for POST /sessions/:parentId/children */
export interface SpawnChildSessionRequest {
  title: string;
  prompt: string;
  repoOwner?: string;
  repoName?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Returned by parent DO's GET /internal/spawn-context */
export interface SpawnContext {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  model: string;
  reasoningEffort: string | null;
  owner: {
    userId: string;
    scmLogin: string | null;
    scmName: string | null;
    scmEmail: string | null;
    scmAccessTokenEncrypted: string | null;
    scmRefreshTokenEncrypted: string | null;
    scmTokenExpiresAt: number | null;
  };
}

/** Returned by child DO's GET /internal/child-summary */
export interface ChildSessionDetail {
  session: {
    id: string;
    title: string;
    status: SessionStatus;
    repoOwner: string;
    repoName: string;
    branchName: string | null;
    model: string;
    createdAt: number;
    updatedAt: number;
  };
  sandbox: { status: SandboxStatus } | null;
  artifacts: Array<{ type: string; url: string; metadata: unknown }>;
  recentEvents: Array<{ type: string; data: unknown; createdAt: number }>;
}

export * from "./integrations";
