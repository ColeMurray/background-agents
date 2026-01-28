/**
 * Shared types for sandbox supervisor and bridge.
 */

/**
 * Git user information for commit attribution.
 */
export interface GitUser {
  name: string;
  email: string;
}

/**
 * Session configuration passed from control plane.
 */
export interface SessionConfig {
  session_id: string;
  repo_owner: string;
  repo_name: string;
  provider: string;
  model: string;
  branch?: string;
  git_user?: GitUser;
}

/**
 * Author information for prompt attribution.
 */
export interface AuthorInfo {
  githubName?: string;
  githubEmail?: string;
  githubLogin?: string;
}

// ============================================================================
// Bridge Events (Sandbox → Control Plane)
// ============================================================================

export interface ReadyEvent {
  type: "ready";
  sandboxId: string;
  opencodeSessionId?: string;
}

export interface HeartbeatEvent {
  type: "heartbeat";
  sandboxId: string;
  status: string;
  timestamp: number;
}

export interface TokenEvent {
  type: "token";
  content: string;
  messageId: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  status: string;
  output?: string;
  messageId: string;
}

export interface StepStartEvent {
  type: "step_start";
  messageId: string;
}

export interface StepFinishEvent {
  type: "step_finish";
  messageId: string;
  cost?: number;
  tokens?: { input: number; output: number };
  reason?: string;
}

export interface ExecutionCompleteEvent {
  type: "execution_complete";
  messageId: string;
  success: boolean;
  error?: string;
}

export interface ErrorEvent {
  type: "error";
  error: string;
  messageId: string;
}

export interface PushCompleteEvent {
  type: "push_complete";
  branchName: string;
}

export interface PushErrorEvent {
  type: "push_error";
  branchName: string;
  error: string;
}

export interface SnapshotReadyEvent {
  type: "snapshot_ready";
  opencodeSessionId?: string;
}

export type BridgeEvent =
  | ReadyEvent
  | HeartbeatEvent
  | TokenEvent
  | ToolCallEvent
  | StepStartEvent
  | StepFinishEvent
  | ExecutionCompleteEvent
  | ErrorEvent
  | PushCompleteEvent
  | PushErrorEvent
  | SnapshotReadyEvent;

// ============================================================================
// Session Commands (Control Plane → Sandbox)
// ============================================================================

export interface PromptCommand {
  type: "prompt";
  messageId: string;
  content: string;
  model?: string;
  author?: AuthorInfo;
}

export interface StopCommand {
  type: "stop";
}

export interface PushCommand {
  type: "push";
  branchName: string;
  repoOwner?: string;
  repoName?: string;
  githubToken?: string;
}

export interface SnapshotCommand {
  type: "snapshot";
}

export interface ShutdownCommand {
  type: "shutdown";
}

export interface GitSyncCompleteCommand {
  type: "git_sync_complete";
}

export type SessionCommand =
  | PromptCommand
  | StopCommand
  | PushCommand
  | SnapshotCommand
  | ShutdownCommand
  | GitSyncCompleteCommand;

// ============================================================================
// OpenCode API Types
// ============================================================================

export interface OpenCodeSession {
  id: string;
}

export interface OpenCodeMessage {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    parentID?: string;
    finish?: string;
  };
  parts: OpenCodePart[];
}

export interface OpenCodeTextPart {
  type: "text";
  id: string;
  messageID: string;
  text: string;
}

export interface OpenCodeToolPart {
  type: "tool";
  id: string;
  messageID: string;
  tool: string;
  callID: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
  };
}

export interface OpenCodeStepStartPart {
  type: "step-start";
  id: string;
  messageID: string;
}

export interface OpenCodeStepFinishPart {
  type: "step-finish";
  id: string;
  messageID: string;
  cost?: number;
  tokens?: { input: number; output: number };
  reason?: string;
}

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeToolPart
  | OpenCodeStepStartPart
  | OpenCodeStepFinishPart;

// ============================================================================
// SSE Event Types
// ============================================================================

export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}
