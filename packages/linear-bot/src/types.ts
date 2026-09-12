/**
 * Type definitions for the Linear bot.
 */

import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import { z } from "zod";

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace for config, runtime-token cache, and issue-to-session mapping
  LINEAR_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: ControlPlaneFetcher;

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
  /**
   * Classifier provider credentials. The deployment binds exactly the one
   * `CLASSIFICATION_MODEL` selects, so each is optional on its own and the
   * classifier guards the branch it needs.
   */
  ANTHROPIC_API_KEY?: string;
  CLASSIFICATION_MODEL?: string; // Optional override; defaults to DEFAULT_CLASSIFICATION_MODEL
  OPENAI_API_KEY?: string;
  SERVICE_AUTH_SECRET?: string; // Per-service sig1 signing secret; also verifies CP callbacks
  LOG_LEVEL?: string;
}

// ─── Repo / Config Types ─────────────────────────────────────────────────────

/**
 * A single repo configuration with an optional label filter.
 * Used for static team→repo mapping (legacy/override).
 */
const staticRepoConfigSchema = z.object({
  owner: z.string(),
  name: z.string(),
  label: z.string().optional(),
});

/**
 * An environment target with an optional label filter. References the stable
 * `env_…` id, not the rename-able display name.
 */
const staticEnvironmentConfigSchema = z.object({
  environmentId: z.string(),
  label: z.string().optional(),
});

/**
 * A mapping entry: a repository or a saved environment. Targets unify instead
 * of migrate — repository entries never stop working; environments join them.
 *
 * The environment variant is listed first, and the order is load-bearing: a
 * stored entry carrying both an `environmentId` and repo keys is ambiguous,
 * and `resolveMappedTarget` launched its environment (`"environmentId" in
 * config`) long before these entries were validated. Environment-first keeps
 * that entry pointed at the same target — validating stored config may reject
 * an entry, but it must never quietly re-point a working one somewhere else.
 */
const staticTargetConfigSchema = z.union([staticEnvironmentConfigSchema, staticRepoConfigSchema]);

export type StaticTargetConfig = z.infer<typeof staticTargetConfigSchema>;

/** The targets stored under one team key, validated as a unit. */
export const teamTargetsSchema = z.array(staticTargetConfigSchema);

/**
 * Static team→target mapping stored in KV under "config:team-repos". Only the
 * entries are schemas: the record is validated key by key on read, so one
 * malformed team never invalidates the others.
 */
export type TeamRepoMapping = Record<string, StaticTargetConfig[]>;

/**
 * The target stored under one project key. Environment-first for the same
 * reason as {@link staticTargetConfigSchema}: an entry holding both shapes
 * keeps resolving to its environment.
 */
export const projectTargetSchema = z.union([
  z.object({ environmentId: z.string() }),
  z.object({ owner: z.string(), name: z.string() }),
]);

/**
 * Project→target mapping stored in KV under "config:project-repos", validated
 * key by key like {@link TeamRepoMapping}.
 */
export type ProjectRepoMapping = Record<string, z.infer<typeof projectTargetSchema>>;

// ─── Issue-to-Session Mapping ────────────────────────────────────────────────

/**
 * The issue→session mapping persisted in KV. Canonical as a schema because the
 * stored value is untrusted on read: `lookupIssueSession` parses with this, so
 * the runtime contract and the type can never drift apart.
 */
export const issueSessionSchema = z.object({
  sessionId: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
  /** Set for repository sessions; absent for environment sessions. */
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  /** Set for environment sessions. */
  environmentId: z.string().optional(),
  model: z.string(),
  agentSessionId: z.string().optional(),
  createdAt: z.number(),
});

export type IssueSession = z.infer<typeof issueSessionSchema>;

// ─── Linear Issue Details ────────────────────────────────────────────────────

const linearNameSchema = z.object({ id: z.string(), name: z.string() });
const linearCommentSchema = z.object({
  body: z.string(),
  user: z.object({ name: z.string() }).nullable().optional(),
});

const linearIssueDetailsSchema = z
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
  promptContext?: string;
  agentSession: {
    id: string;
    creatorId?: string | null;
    issue?: AgentSessionWebhookIssue;
    comment?: { body: string; userId?: string };
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
