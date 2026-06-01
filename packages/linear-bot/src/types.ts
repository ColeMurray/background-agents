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
  DEFAULT_PLAN_MODEL?: string;
  APP_NAME?: string;

  // OAuth app credentials
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;

  // Worker public URL (for OAuth callback)
  WORKER_URL: string;

  // Secrets
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_API_KEY?: string; // kept for backward compat / fallback
  ANTHROPIC_API_KEY: string;
  INTERNAL_CALLBACK_SECRET?: string;
  LOG_LEVEL?: string;
  LINEAR_COMMENT_MAX_LENGTH?: string;
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
export type {
  RepoConfig,
  RepoMetadata,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
} from "@open-inspect/shared";

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

// Re-export CallbackContext types from shared
export type { LinearCallbackContext, CallbackContext } from "@open-inspect/shared";
import type { LinearCallbackContext, PlanArtifact } from "@open-inspect/shared";

/**
 * Completion callback payload from control-plane.
 */
export interface CompletionCallback {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
  timestamp: number;
  signature: string;
  context: LinearCallbackContext;
}

/**
 * Tool call callback payload from control-plane (ephemeral, best-effort).
 */
export interface ToolCallCallback {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  status?: string;
  timestamp: number;
  context: LinearCallbackContext;
  signature: string;
}

/**
 * Plan-status callback payload from control-plane. Fired when a plan
 * verdict (approve/reject) was set from a different channel than Linear
 * — e.g. the user approved a Linear-triggered plan from the web UI — so
 * the Linear bot can emit a follow-up agent activity and update the
 * Agent Session's plan widget. The Linear elicitation activity stays
 * in the issue thread; we add a `response` activity announcing the
 * verdict on top.
 *
 * Mirrors the wire shape of `notifyPlanStatus` in the control-plane.
 */
export interface PlanStatusCallback {
  sessionId: string;
  planVersion: number;
  plan: PlanArtifact;
  verdict: "approved" | "rejected";
  approverAuthorId: string | null;
  approverDisplayName?: string;
  implementationModel?: string;
  reason?: string;
  timestamp: number;
  signature: string;
  context: LinearCallbackContext;
}

/**
 * Session-lifecycle callback payload from control-plane (archive /
 * unarchive). Mirrors the slack-bot SessionLifecycleCallback shape.
 */
export interface SessionLifecycleCallback {
  sessionId: string;
  event: "archived" | "unarchived";
  actorAuthorId: string | null;
  actorDisplayName?: string;
  timestamp: number;
  signature: string;
  context: LinearCallbackContext;
}

// ─── Classification Types ────────────────────────────────────────────────────

export type { ClassificationResult, ConfidenceLevel } from "@open-inspect/shared";

// ─── Event / Artifact Types ──────────────────────────────────────────────────

export type {
  EventResponse,
  ListEventsResponse,
  ArtifactResponse,
  ListArtifactsResponse,
  ToolCallSummary,
  ArtifactInfo,
  AgentResponse,
} from "@open-inspect/shared";

// ─── User Preferences ────────────────────────────────────────────────────────

export type { UserPreferences } from "@open-inspect/shared";

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

// ─── Webhook Payload Types ──────────────────────────────────────────────────

export interface AgentSessionWebhookIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority: number;
  priorityLabel: string;
  team: { id: string; key: string; name: string };
  teamId?: string;
  labels?: Array<{ id: string; name: string }>;
  assignee?: { id: string; name: string };
  project?: { id: string; name: string };
}

export interface AgentSessionWebhook {
  type: string;
  action: string;
  organizationId: string;
  webhookId: string;
  appUserId?: string;
  agentSession: {
    id: string;
    issue?: AgentSessionWebhookIssue;
    comment?: { body?: string; bodyData?: unknown };
    promptContext?: string;
  };
  agentActivity?: {
    content?: {
      type?: string;
      body?: string;
    };
  };
}
