/**
 * Type definitions for the Linear bot.
 */

import type { LinearCallbackContext } from "@open-inspect/shared";
import { z } from "zod";

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace for config, runtime-token cache, and issue-to-session mapping
  LINEAR_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
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
 * An environment target with an optional label filter. References the stable
 * `env_…` id, not the rename-able display name.
 */
export interface StaticEnvironmentConfig {
  environmentId: string;
  label?: string;
}

/**
 * A mapping entry: a repository or a saved environment. Targets unify instead
 * of migrate — repository entries never stop working; environments join them.
 */
export type StaticTargetConfig = StaticRepoConfig | StaticEnvironmentConfig;

/**
 * Static team→target mapping stored in KV under "config:team-repos".
 */
export interface TeamRepoMapping {
  [teamId: string]: StaticTargetConfig[];
}

/**
 * Dynamic repo config from control plane.
 */
export type {
  RepoConfig,
  RepoMetadata,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
  Environment,
  ListEnvironmentsResponse,
} from "@open-inspect/shared";

/**
 * Project→target mapping stored in KV under "config:project-repos".
 */
export interface ProjectRepoMapping {
  [projectId: string]: { owner: string; name: string } | { environmentId: string };
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
  /** Set for repository sessions; absent for environment sessions. */
  repoOwner?: string;
  repoName?: string;
  /** Set for environment sessions. */
  environmentId?: string;
  model: string;
  agentSessionId?: string;
  createdAt: number;
}

// Re-export CallbackContext types from shared
export type { LinearCallbackContext, CallbackContext } from "@open-inspect/shared";

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

const linearNameSchema = z.object({ id: z.string(), name: z.string() });
const linearCommentSchema = z.object({
  body: z.string(),
  user: z.object({ name: z.string() }).nullable().optional(),
});

export const linearIssueDetailsSchema = z
  .object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    url: z.string(),
    priority: z.number(),
    priorityLabel: z.string(),
    labels: z
      .object({ nodes: z.array(linearNameSchema) })
      .nullable()
      .optional(),
    project: linearNameSchema.nullable().optional(),
    assignee: linearNameSchema.nullable().optional(),
    team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
    comments: z
      .object({ nodes: z.array(linearCommentSchema) })
      .nullable()
      .optional(),
  })
  .transform(({ labels, comments, ...issue }) => ({
    ...issue,
    labels: labels?.nodes ?? [],
    comments: comments?.nodes ?? [],
  }));

export type LinearIssueDetails = z.infer<typeof linearIssueDetailsSchema>;

export const linearIssueDetailsResponseSchema = z.object({
  data: z
    .object({
      issue: linearIssueDetailsSchema.nullable().optional(),
    })
    .optional(),
});

export const linearRepoSuggestionsResponseSchema = z.object({
  data: z
    .object({
      issueRepositorySuggestions: z
        .object({
          suggestions: z.array(
            z.object({
              repositoryFullName: z.string(),
              confidence: z.number(),
            })
          ),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

export const linearUserResponseSchema = z.object({
  data: z
    .object({
      user: z
        .object({
          id: z.string(),
          name: z.string(),
          email: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

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
  appUserId: string;
  agentSession: {
    id: string;
    creatorId?: string | null;
    issue?: AgentSessionWebhookIssue;
    comment?: { body: string; userId?: string };
    promptContext?: string;
  };
  agentActivity?: {
    userId?: string;
    signal?: string;
    content?: {
      type?: string;
      body?: string;
    };
  };
}
