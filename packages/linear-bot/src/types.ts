/**
 * Type definitions for the Linear bot.
 */

import {
  linearCompletionCallbackSchema,
  linearToolCallCallbackSchema,
  type LinearCompletionCallback,
  type LinearToolCallCallback,
} from "@open-inspect/shared";
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
  SERVICE_AUTH_SECRET?: string; // Per-service sig1 signing secret; also verifies CP callbacks
  LOG_LEVEL?: string;
}

// ─── Repo / Config Types ─────────────────────────────────────────────────────

/**
 * A single repo configuration with an optional label filter.
 * Used for static team→repo mapping (legacy/override).
 */
const staticRepoConfigSchema = z.strictObject({
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
});

export type StaticRepoConfig = z.infer<typeof staticRepoConfigSchema>;

/**
 * An environment target with an optional label filter. References the stable
 * `env_…` id, not the rename-able display name.
 */
const staticEnvironmentConfigSchema = z.strictObject({
  environmentId: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
});

export type StaticEnvironmentConfig = z.infer<typeof staticEnvironmentConfigSchema>;

/**
 * A mapping entry: a repository or a saved environment. Targets unify instead
 * of migrate — repository entries never stop working; environments join them.
 */
export type StaticTargetConfig = StaticRepoConfig | StaticEnvironmentConfig;
const staticTargetConfigSchema = z.union([staticRepoConfigSchema, staticEnvironmentConfigSchema]);

/**
 * Static team→target mapping stored in KV under "config:team-repos".
 */
export type TeamRepoMapping = Record<string, StaticTargetConfig[]>;

/**
 * Dynamic repo config from control plane.
 */
export type {
  RepoConfig,
  RepoMetadata,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
} from "@open-inspect/shared/types/repository-catalog";
export type {
  Environment,
  ListEnvironmentsResponse,
} from "@open-inspect/shared/types/environments";

/**
 * Project→target mapping stored in KV under "config:project-repos".
 */
export type ProjectRepoMapping = Record<string, StaticTargetConfig>;

export interface ParsedMapping<T> {
  mapping: T;
  invalidEntries: string[];
}

const unknownMappingSchema = z.record(z.string(), z.unknown());

export function parseTeamRepoMapping(value: unknown): ParsedMapping<TeamRepoMapping> {
  const record = unknownMappingSchema.safeParse(value);
  if (!record.success) return { mapping: {}, invalidEntries: ["<root>"] };

  const mapping: TeamRepoMapping = {};
  const invalidEntries: string[] = [];
  for (const [teamId, targets] of Object.entries(record.data)) {
    if (!Array.isArray(targets)) {
      invalidEntries.push(teamId);
      continue;
    }
    const parsedTargets = targets.flatMap((target, index) => {
      const parsed = staticTargetConfigSchema.safeParse(target);
      if (parsed.success) return [parsed.data];
      invalidEntries.push(`${teamId}[${index}]`);
      return [];
    });
    if (parsedTargets.length > 0) mapping[teamId] = parsedTargets;
  }
  return { mapping, invalidEntries };
}

export function parseProjectRepoMapping(value: unknown): ParsedMapping<ProjectRepoMapping> {
  const record = unknownMappingSchema.safeParse(value);
  if (!record.success) return { mapping: {}, invalidEntries: ["<root>"] };

  const mapping: ProjectRepoMapping = {};
  const invalidEntries: string[] = [];
  for (const [projectId, target] of Object.entries(record.data)) {
    const parsed = staticTargetConfigSchema.safeParse(target);
    if (parsed.success) mapping[projectId] = parsed.data;
    else invalidEntries.push(projectId);
  }
  return { mapping, invalidEntries };
}

export const userPreferencesSchema = z.strictObject({
  userId: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  updatedAt: z.number().finite(),
});

// ─── Issue-to-Session Mapping ────────────────────────────────────────────────

/**
 * The issue→session mapping persisted in KV. Canonical as a schema because the
 * stored value is untrusted on read: `lookupIssueSession` parses with this, so
 * the runtime contract and the type can never drift apart.
 */
const issueSessionBaseShape = {
  sessionId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  issueIdentifier: z.string().trim().min(1),
  model: z.string().trim().min(1),
  agentSessionId: z.string().trim().min(1).optional(),
  createdAt: z.number().finite(),
};

const issueSessionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("repository"),
    owner: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("environment"),
    environmentId: z.string().trim().min(1),
  }),
]);

const canonicalIssueSessionSchema = z.strictObject({
  ...issueSessionBaseShape,
  target: issueSessionTargetSchema,
});

const legacyRepositoryIssueSessionSchema = z
  .strictObject({
    ...issueSessionBaseShape,
    repoOwner: z.string().trim().min(1),
    repoName: z.string().trim().min(1),
  })
  .transform(({ repoOwner, repoName, ...session }) => ({
    ...session,
    target: { kind: "repository" as const, owner: repoOwner, name: repoName },
  }));

const legacyEnvironmentIssueSessionSchema = z
  .strictObject({
    ...issueSessionBaseShape,
    environmentId: z.string().trim().min(1),
  })
  .transform(({ environmentId, ...session }) => ({
    ...session,
    target: { kind: "environment" as const, environmentId },
  }));

/** Decode persisted records into the sole canonical issue-session shape. */
export const issueSessionSchema = z.union([
  canonicalIssueSessionSchema,
  legacyRepositoryIssueSessionSchema,
  legacyEnvironmentIssueSessionSchema,
]);

export type IssueSession = z.infer<typeof issueSessionSchema>;

// Re-export CallbackContext types from shared
export type { LinearCallbackContext, CallbackContext } from "@open-inspect/shared";

export const completionCallbackSchema = linearCompletionCallbackSchema;
export type CompletionCallback = LinearCompletionCallback;

/**
 * Tool call callback payload from control-plane (ephemeral, best-effort).
 */
export const toolCallCallbackSchema = linearToolCallCallbackSchema;
export type ToolCallCallback = LinearToolCallCallback;

// ─── Classification Types ────────────────────────────────────────────────────

export type {
  ClassificationResult,
  ConfidenceLevel,
} from "@open-inspect/shared/types/repository-catalog";

// ─── Event / Artifact Types ──────────────────────────────────────────────────

export type {
  ArtifactResponse,
  ListArtifactsResponse,
  ToolCallSummary,
  ArtifactInfo,
  AgentResponse,
} from "@open-inspect/shared";
export type { EventResponse, ListEventsResponse } from "@open-inspect/shared/types/sandbox-events";

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

const webhookStringSchema = z.string().trim().min(1);
const webhookNamedEntitySchema = z.object({ id: webhookStringSchema, name: webhookStringSchema });

export const agentSessionWebhookIssueSchema = z.object({
  id: webhookStringSchema,
  identifier: webhookStringSchema,
  title: webhookStringSchema,
  description: z.string().nullable().optional(),
  url: webhookStringSchema,
  priority: z.number().nullable().optional(),
  priorityLabel: z.string().nullable().optional(),
  team: webhookNamedEntitySchema.extend({ key: webhookStringSchema }).nullable().optional(),
  teamId: webhookStringSchema.nullable().optional(),
  labels: z.array(webhookNamedEntitySchema).nullable().optional(),
  assignee: webhookNamedEntitySchema.nullable().optional(),
  project: webhookNamedEntitySchema.nullable().optional(),
});

export type AgentSessionWebhookIssue = z.infer<typeof agentSessionWebhookIssueSchema>;

const agentSessionEventEnvelopeSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: webhookStringSchema,
});

const stopAgentSessionWebhookSchema = agentSessionEventEnvelopeSchema.extend({
  agentSession: z.object({
    id: webhookStringSchema,
    issue: z.object({ id: webhookStringSchema }).optional(),
  }),
});

const startAgentSessionWebhookSchema = agentSessionEventEnvelopeSchema.extend({
  action: z.enum(["created", "prompted"]),
  organizationId: webhookStringSchema,
  webhookId: webhookStringSchema,
  appUserId: webhookStringSchema,
  promptContext: z.string().optional(),
  agentSession: z.object({
    id: webhookStringSchema,
    creatorId: webhookStringSchema.nullable().optional(),
    issue: agentSessionWebhookIssueSchema,
    comment: z.object({ body: z.string(), userId: webhookStringSchema.optional() }).optional(),
  }),
  agentActivity: z
    .object({
      userId: webhookStringSchema.optional(),
      signal: z.string().optional(),
      content: z.object({ type: z.string().optional(), body: z.string().optional() }).optional(),
    })
    .optional(),
});

export type AgentSessionWebhook = z.infer<typeof startAgentSessionWebhookSchema>;

export type AgentSessionCommand =
  | { kind: "stop"; action: string; agentSessionId: string; issueId?: string }
  | { kind: "start_or_follow_up"; webhook: AgentSessionWebhook };

export type AgentSessionWebhookParseResult =
  | { kind: "invalid"; reason: "invalid_envelope" | "invalid_stop" | "invalid_start" }
  | { kind: "unsupported"; eventType: string; action: string }
  | AgentSessionCommand;

export function parseAgentSessionWebhook(payload: unknown): AgentSessionWebhookParseResult {
  const envelope = agentSessionEventEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return { kind: "invalid", reason: "invalid_envelope" };

  const stopSignal = z
    .object({ agentActivity: z.object({ signal: z.literal("stop") }) })
    .safeParse(payload).success;
  if (stopSignal || envelope.data.action === "stopped" || envelope.data.action === "cancelled") {
    const stop = stopAgentSessionWebhookSchema.safeParse(payload);
    if (!stop.success) return { kind: "invalid", reason: "invalid_stop" };
    return {
      kind: "stop",
      action: stop.data.action,
      agentSessionId: stop.data.agentSession.id,
      issueId: stop.data.agentSession.issue?.id,
    };
  }

  if (envelope.data.action === "created" || envelope.data.action === "prompted") {
    const start = startAgentSessionWebhookSchema.safeParse(payload);
    if (!start.success) return { kind: "invalid", reason: "invalid_start" };
    return { kind: "start_or_follow_up", webhook: start.data };
  }

  return {
    kind: "unsupported",
    eventType: envelope.data.type,
    action: envelope.data.action,
  };
}
