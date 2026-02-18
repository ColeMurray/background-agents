/**
 * Type definitions for the Linear bot.
 */

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace for issue-to-session mapping
  LINEAR_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;

  // Secrets
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_API_KEY: string;
  INTERNAL_CALLBACK_SECRET?: string;
  LOG_LEVEL?: string;
}

/**
 * Linear webhook payload envelope.
 * https://developers.linear.app/docs/graphql/webhooks
 */
export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: "Issue" | "Comment" | "IssueLabel";
  data: LinearIssueData;
  url: string;
  createdAt: string;
  organizationId: string;
}

/**
 * Linear issue data from webhook.
 */
export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority: number;
  priorityLabel: string;
  state: {
    id: string;
    name: string;
    type: string;
  };
  team: {
    id: string;
    key: string;
    name: string;
  };
  labels: Array<{
    id: string;
    name: string;
  }>;
  assignee?: {
    id: string;
    name: string;
    email: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Mapping from Linear team to GitHub repo.
 * Stored in KV under key "config:team-repos".
 */
export interface TeamRepoMapping {
  /** Linear team ID → GitHub repo in "owner/name" format */
  [teamId: string]: {
    owner: string;
    name: string;
  };
}

/**
 * Trigger configuration.
 * Stored in KV under key "config:triggers".
 */
export interface TriggerConfig {
  /** Label name that triggers agent work (e.g. "agent" or "🔵agent") */
  triggerLabel: string;
  /** Also trigger on issue assignment to a specific assignee name */
  triggerAssignee?: string;
  /** Auto-trigger on all new issues (use with caution) */
  autoTriggerOnCreate: boolean;
}

/**
 * Issue-to-session mapping stored in KV.
 */
export interface IssueSession {
  sessionId: string;
  issueId: string;
  issueIdentifier: string;
  repoOwner: string;
  repoName: string;
  model: string;
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
