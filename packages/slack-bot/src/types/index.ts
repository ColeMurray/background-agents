/**
 * Type definitions for the Slack bot.
 */

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace
  SLACK_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  CLASSIFICATION_MODEL: string;

  // Secrets
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APP_TOKEN?: string;
  ANTHROPIC_API_KEY: string;
  CONTROL_PLANE_API_KEY?: string;
  INTERNAL_CALLBACK_SECRET?: string; // For verifying callbacks from control-plane
  LOG_LEVEL?: string;
}

/**
 * Repository configuration for the classifier.
 */
export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  displayName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  aliases?: string[];
  keywords?: string[];
  channelAssociations?: string[];
}

/**
 * Repository metadata from the control plane API.
 */
export interface RepoMetadata {
  description?: string;
  aliases?: string[];
  channelAssociations?: string[];
  keywords?: string[];
}

/**
 * Repository as returned by the control plane API.
 */
export interface ControlPlaneRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  metadata?: RepoMetadata;
}

/**
 * Response from the control plane /repos endpoint.
 */
export interface ControlPlaneReposResponse {
  repos: ControlPlaneRepo[];
  cached: boolean;
  cachedAt: string;
}

/**
 * Thread context for classification.
 */
export interface ThreadContext {
  channelId: string;
  channelName?: string;
  channelDescription?: string;
  threadTs?: string;
  previousMessages?: string[];
}

/**
 * Result of repository classification.
 */
export interface ClassificationResult {
  repo: RepoConfig | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  alternatives?: RepoConfig[];
  needsClarification: boolean;
}

/**
 * Slack event types.
 */
export interface SlackEvent {
  type: string;
  event: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
  event_id: string;
  event_time: number;
  team_id: string;
}

/**
 * Slack message event.
 */
export interface SlackMessageEvent {
  type: "message";
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

/**
 * Slack app_mention event.
 */
export interface SlackAppMentionEvent {
  type: "app_mention";
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

/**
 * Callback context passed with prompts for follow-up notifications.
 */
export interface CallbackContext {
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
}

/**
 * Thread-to-session mapping stored in KV for conversation continuity.
 */
export interface ThreadSession {
  sessionId: string;
  repoId: string;
  repoFullName: string;
  model: string;
  /** Unix timestamp of when the session was created. Used for debugging and observability. */
  createdAt: number;
}

/**
 * Completion callback payload from control-plane.
 */
export interface CompletionCallback {
  sessionId: string;
  messageId: string;
  success: boolean;
  timestamp: number;
  signature: string;
  context: CallbackContext;
}

/**
 * Event response from control-plane events API.
 */
export interface EventResponse {
  id: string;
  type: string;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

/**
 * List events response from control-plane.
 */
export interface ListEventsResponse {
  events: EventResponse[];
  cursor?: string;
  hasMore: boolean;
}

/**
 * Tool call summary for Slack display.
 */
export interface ToolCallSummary {
  tool: string;
  summary: string;
}

/**
 * Artifact information (PRs, branches, etc.).
 */
export interface ArtifactInfo {
  type: string;
  url: string;
  label: string;
}

/**
 * Aggregated agent response for display.
 */
export interface AgentResponse {
  textContent: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactInfo[];
  success: boolean;
}

/**
 * User preferences stored in KV.
 */
export interface UserPreferences {
  userId: string;
  model: string;
  updatedAt: number;
}
