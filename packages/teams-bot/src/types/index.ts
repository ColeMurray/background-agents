/**
 * Type definitions for the Teams bot.
 */

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace
  TEAMS_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  CLASSIFICATION_MODEL: string;

  // Secrets
  MICROSOFT_APP_ID: string;
  MICROSOFT_APP_PASSWORD: string;
  MICROSOFT_TENANT_ID: string;
  ANTHROPIC_API_KEY: string;
  CONTROL_PLANE_API_KEY?: string;
  INTERNAL_CALLBACK_SECRET?: string;
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
 * Callback context passed with prompts for follow-up notifications.
 */
export type { TeamsCallbackContext, CallbackContext } from "@open-inspect/shared";

/**
 * Thread-to-session mapping stored in KV for conversation continuity.
 */
export interface ThreadSession {
  sessionId: string;
  repoId: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  typingMode?: string;
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
  context: TeamsCallbackContext;
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
 * Artifact response from control-plane artifacts API.
 */
export interface ArtifactResponse {
  id: string;
  type: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * List artifacts response from control-plane.
 */
export interface ListArtifactsResponse {
  artifacts: ArtifactResponse[];
}

/**
 * Tool call summary for display.
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
  metadata?: Record<string, unknown> | null;
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
  reasoningEffort?: string;
  updatedAt: number;
}

/**
 * Bot Framework Activity (subset of fields the bot needs).
 */
export interface Activity {
  type: string;
  id: string;
  timestamp: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string; aadObjectId?: string };
  conversation: {
    id: string;
    conversationType?: string;
    tenantId?: string;
    isGroup?: boolean;
  };
  recipient: { id: string; name?: string };
  text?: string;
  replyToId?: string;
  value?: Record<string, unknown>;
  name?: string;
  channelData?: {
    teamsChannelId?: string;
    teamsTeamId?: string;
    channel?: { id: string; name?: string };
    team?: { id: string; name?: string };
  };
  entities?: Array<{
    type: string;
    mentioned?: { id: string; name?: string };
    text?: string;
  }>;
}
