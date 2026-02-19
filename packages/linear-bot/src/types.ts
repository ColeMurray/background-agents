/**
 * Type definitions for the Linear bot.
 */

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace for config, OAuth tokens, and issue-to-session mapping
  LINEAR_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;

  // OAuth app credentials
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;

  // Worker public URL (for OAuth callback)
  WORKER_URL: string;

  // Secrets
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_API_KEY: string; // kept for backward compat / fallback
  ANTHROPIC_API_KEY: string;
  INTERNAL_CALLBACK_SECRET?: string;
  LOG_LEVEL?: string;
}

// ─── OAuth Types ─────────────────────────────────────────────────────────────

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

export interface StoredTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ─── Repo / Config Types ─────────────────────────────────────────────────────

/**
 * A single repo configuration with an optional label filter.
 * Used for static team→repo mapping (legacy/override).
 */
export interface StaticRepoConfig {
  owner: string;
  name: string;
  label?: string;
}

/**
 * Static team→repo mapping stored in KV under "config:team-repos".
 */
export interface TeamRepoMapping {
  [teamId: string]: StaticRepoConfig[];
}

/**
 * Dynamic repo config from control plane.
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
}

/**
 * Repository metadata from the control plane API.
 */
export interface RepoMetadata {
  description?: string;
  aliases?: string[];
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
 * Project→repo mapping stored in KV under "config:project-repos".
 */
export interface ProjectRepoMapping {
  [projectId: string]: { owner: string; name: string };
}

/**
 * Trigger configuration stored in KV under "config:triggers".
 */
export interface TriggerConfig {
  triggerLabel: string;
  triggerAssignee?: string;
  autoTriggerOnCreate: boolean;
  triggerCommand?: string;
}

// ─── Issue-to-Session Mapping ────────────────────────────────────────────────

export interface IssueSession {
  sessionId: string;
  issueId: string;
  issueIdentifier: string;
  repoOwner: string;
  repoName: string;
  model: string;
  agentSessionId?: string;
  createdAt: number;
}

/**
 * Callback context passed with prompts for follow-up notifications.
 */
export interface CallbackContext {
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  repoFullName: string;
  model: string;
  agentSessionId?: string;
  organizationId?: string;
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

// ─── Classification Types ────────────────────────────────────────────────────

export interface ClassificationResult {
  repo: RepoConfig | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  alternatives?: RepoConfig[];
  needsClarification: boolean;
}

// ─── Event / Artifact Types ──────────────────────────────────────────────────

export interface EventResponse {
  id: string;
  type: string;
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
  type: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactResponse[];
}

export interface ToolCallSummary {
  tool: string;
  summary: string;
}

export interface ArtifactInfo {
  type: string;
  url: string;
  label: string;
  metadata?: Record<string, unknown> | null;
}

export interface AgentResponse {
  textContent: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactInfo[];
  success: boolean;
}

// ─── User Preferences ────────────────────────────────────────────────────────

export interface UserPreferences {
  userId: string;
  model: string;
  reasoningEffort?: string;
  updatedAt: number;
}

// ─── Linear Issue Details ────────────────────────────────────────────────────

export interface LinearIssueDetails {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  priority: number;
  priorityLabel: string;
  labels: Array<{ id: string; name: string }>;
  project?: { id: string; name: string } | null;
  assignee?: { id: string; name: string } | null;
  team: { id: string; key: string; name: string };
  comments: Array<{ body: string; user?: { name: string } }>;
}
