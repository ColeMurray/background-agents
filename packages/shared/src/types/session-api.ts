import { z } from "zod";
import { sessionSkillSelectionSchema } from "./skills";
import type { AgentResponse } from "./artifacts";
import { sessionRepositoriesInputSchema } from "./repositories";
import type { EventResponse } from "./sandbox-events";
import { MAX_WEB_PROMPT_CHARS, promptContentSchema } from "./prompts";
import { modelProviderSelectionsSchema } from "./provider-accounts";
import {
  messageSourceSchema,
  sessionStatusSchema,
  type SandboxStatus,
  type Session,
  type SessionStatus,
} from "./sessions";

export const userPreferencesSchema = z.object({
  userId: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  updatedAt: z.number(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

const nonEmptyStringSchema = z.string().trim().min(1);

export const MAX_CHILD_FOLLOW_UP_PROMPT_CHARS = MAX_WEB_PROMPT_CHARS;

export const slackCallbackContextSchema = z.object({
  source: z.literal("slack"),
  channel: z.string(),
  threadTs: z.string(),
  repoFullName: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  reactionMessageTs: z.string().optional(),
  /**
   * Set when the session belongs to an automation rather than an interactive
   * request. A thread follow-up completes through the same callback as an
   * `@mention` turn, so the route alone cannot tell the two apart, and only the
   * control plane knows which automation (if any) owns the thread.
   */
  automationId: z.string().optional(),
});

export type SlackCallbackContext = z.infer<typeof slackCallbackContextSchema>;

const linearCallbackContextBaseSchema = z.strictObject({
  source: z.literal("linear"),
  issueId: nonEmptyStringSchema,
  issueIdentifier: nonEmptyStringSchema,
  issueUrl: nonEmptyStringSchema,
  /** Settings repository when one can be resolved for this Linear message. */
  repoFullName: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema,
  agentSessionId: nonEmptyStringSchema.optional(),
  emitToolProgressActivities: z.boolean().optional(),
});

export const linearCallbackContextSchema = z.union([
  linearCallbackContextBaseSchema.extend({
    organizationId: nonEmptyStringSchema,
    /** Installed Linear app-user identity used to verify runtime credentials. */
    appUserId: nonEmptyStringSchema,
    /** Move the issue to its team's started workflow when this message begins processing. */
    transitionIssueOnStart: z.literal(true),
  }),
  linearCallbackContextBaseSchema.extend({
    organizationId: nonEmptyStringSchema.optional(),
    appUserId: nonEmptyStringSchema.optional(),
    transitionIssueOnStart: z.literal(false).optional(),
  }),
]);

export type LinearCallbackContext = z.infer<typeof linearCallbackContextSchema>;

export const linearStartCallbackSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  timestamp: z.number().refine(Number.isFinite),
  signature: nonEmptyStringSchema,
  context: linearCallbackContextSchema,
});

export type LinearStartCallback = z.infer<typeof linearStartCallbackSchema>;

/**
 * Why a Linear message ended unsuccessfully. `stopped` and `cancelled` are
 * user-initiated, so the bot confirms them itself and must not post an error.
 */
export const linearTerminationReasonSchema = z.enum([
  "stopped",
  "cancelled",
  "execution_timeout",
  "sandbox_failure",
  "provider_unavailable",
]);

export type LinearTerminationReason = z.infer<typeof linearTerminationReasonSchema>;

export const linearCompletionCallbackPayloadSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  success: z.boolean(),
  error: z.string().optional(),
  terminationReason: linearTerminationReasonSchema.optional(),
  timestamp: z.number().refine(Number.isFinite),
  context: linearCallbackContextSchema,
});

export const linearCompletionCallbackSchema = linearCompletionCallbackPayloadSchema.extend({
  signature: nonEmptyStringSchema,
});

export type LinearCompletionCallback = z.infer<typeof linearCompletionCallbackSchema>;

/** Cap on the tool output forwarded to Linear as an `action` result. */
export const MAX_LINEAR_TOOL_RESULT_CHARS = 1000;

export const linearToolCallCallbackPayloadSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  tool: nonEmptyStringSchema,
  args: z.record(z.string(), z.unknown()),
  callId: nonEmptyStringSchema,
  status: z.string().optional(),
  /** Truncated tool output; present only on terminal (`completed`/`error`) deliveries. */
  result: z.string().max(MAX_LINEAR_TOOL_RESULT_CHARS).optional(),
  resultTruncated: z.boolean().optional(),
  timestamp: z.number().refine(Number.isFinite),
  context: linearCallbackContextSchema,
});

export const linearToolCallCallbackSchema = linearToolCallCallbackPayloadSchema.extend({
  signature: nonEmptyStringSchema,
});

export type LinearToolCallCallback = z.infer<typeof linearToolCallCallbackSchema>;

/** Cap on the assistant-text snippet carried by a Linear progress callback. */
export const MAX_LINEAR_PROGRESS_TEXT_CHARS = 2000;

export const linearProgressPhaseSchema = z.enum(["thinking", "tool_call", "responding"]);
export type LinearProgressPhase = z.infer<typeof linearProgressPhaseSchema>;

/**
 * `heartbeat` — periodic keepalive while a Linear message is running, so the
 * Linear agent session never goes stale. `step_finish` — an assistant text
 * segment just completed (the model paused to call tools), so the bot can
 * surface that text immediately.
 */
export const linearProgressTriggerSchema = z.enum(["heartbeat", "step_finish"]);
export type LinearProgressTrigger = z.infer<typeof linearProgressTriggerSchema>;

export const linearProgressCallbackPayloadSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  timestamp: z.number().refine(Number.isFinite),
  elapsedMs: z.number().int().nonnegative(),
  trigger: linearProgressTriggerSchema,
  toolCallCount: z.number().int().nonnegative().optional(),
  phase: linearProgressPhaseSchema.optional(),
  currentTool: z
    .strictObject({
      tool: nonEmptyStringSchema,
      callId: nonEmptyStringSchema,
      status: z.string().optional(),
    })
    .optional(),
  latestText: z.string().max(MAX_LINEAR_PROGRESS_TEXT_CHARS).optional(),
  /** True when `latestText` is a finished segment rather than a mid-stream snapshot. */
  latestTextComplete: z.boolean().optional(),
  context: linearCallbackContextSchema,
});

export const linearProgressCallbackSchema = linearProgressCallbackPayloadSchema.extend({
  signature: nonEmptyStringSchema,
});

export type LinearProgressCallback = z.infer<typeof linearProgressCallbackSchema>;

export const automationCallbackContextSchema = z.object({
  source: z.literal("automation"),
  automationId: z.string(),
  runId: z.string(),
  automationName: z.string(),
});

export type AutomationCallbackContext = z.infer<typeof automationCallbackContextSchema>;

export const callbackContextSchema = z.union([
  slackCallbackContextSchema,
  linearCallbackContextSchema,
  automationCallbackContextSchema,
]);

export type CallbackContext = z.infer<typeof callbackContextSchema>;

export const sendPromptRequestSchema = z
  .object({
    content: promptContentSchema,
    source: messageSourceSchema.optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: z.unknown().optional(),
    callbackContext: z.unknown().optional(),
  })
  .refine(
    (prompt) =>
      prompt.content.trim().length > 0 ||
      (Array.isArray(prompt.attachments) && prompt.attachments.length > 0),
    {
      message: "Prompt content must not be blank without attachments",
      path: ["content"],
    }
  );

export type SendPromptRequest = z.infer<typeof sendPromptRequestSchema>;

export const sessionBudgetUpdateSchema = z.strictObject({
  maxCostUsd: z.number().finite().positive().nullable(),
});

export type SessionBudgetUpdate = z.infer<typeof sessionBudgetUpdateSchema>;

/** Request body for POST /sessions/:parentId/children/:childId/prompt. */
export const childFollowUpPromptRequestSchema = z.strictObject({
  content: z
    .string()
    .min(1)
    .max(MAX_CHILD_FOLLOW_UP_PROMPT_CHARS)
    .refine((content) => content.trim().length > 0, { message: "content must not be blank" }),
});

export type ChildFollowUpPromptRequest = z.infer<typeof childFollowUpPromptRequestSchema>;

function hasRepositoryIdentifier(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

interface CreateSessionRepositoryFields {
  repoOwner?: string | null;
  repoName?: string | null;
  branch?: string;
}

function hasMatchingRepositoryIdentifiers(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) === hasRepositoryIdentifier(data.repoName);
}

function hasRepositoryForBranch(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) || !data.branch?.trim();
}

function hasScalarRepositoryTarget(data: CreateSessionRepositoryFields): boolean {
  return (
    hasRepositoryIdentifier(data.repoOwner) ||
    hasRepositoryIdentifier(data.repoName) ||
    Boolean(data.branch?.trim())
  );
}

function hasExclusiveSessionTarget(
  data: CreateSessionRepositoryFields & {
    repositories?: unknown[] | null;
    environmentId?: string | null;
  }
): boolean {
  // At most one target mode may be selected: a named environment
  // (environmentId), an ad-hoc repository list (repositories), or the scalar
  // repoOwner/repoName/branch form. Presence-based, not length-based: any
  // provided array selects the list mode (sessionRepositoriesInputSchema
  // separately rejects empty lists, so [] can never smuggle another mode
  // through).
  const activeModes = [
    Boolean(data.repositories),
    hasRepositoryIdentifier(data.environmentId),
    hasScalarRepositoryTarget(data),
  ].filter(Boolean).length;
  return activeModes <= 1;
}

const createSessionRequestBaseSchema = z.object({
  repoOwner: z.string().trim().min(1).nullish(),
  repoName: z.string().trim().min(1).nullish(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  /**
   * Ordered repository list ([0] = primary). Mutually exclusive with the
   * scalar repoOwner/repoName/branch fields and environmentId.
   */
  repositories: sessionRepositoriesInputSchema.optional(),
  /**
   * Launch from a named environment: its snapshotted repositories become the
   * session's repository list and sessions.environment_id records provenance
   * (design §5.5/§7.6). Mutually exclusive with repositories and the scalar
   * fields.
   */
  environmentId: z.string().trim().min(1).nullish(),
  /** Managed skills are resolved and pinned when the session is created. */
  skillSelection: sessionSkillSelectionSchema.optional(),
  /** Explicit account/API-key choices. Omission resolves provider policy. */
  providerSelections: modelProviderSelectionsSchema.optional(),
});

export const createSessionRequestSchema = createSessionRequestBaseSchema
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionInputSchema = createSessionRequestBaseSchema
  .extend({
    // Profile fields accompany the identity asserted by a verified principal;
    // callers may not assert provider/user IDs or SCM credentials. The
    // control plane treats actorEmail as identity-bearing only when an
    // email-attesting Slack/Linear service signs this exact request body.
    scmLogin: z.string().optional(),
    scmName: z.string().optional(),
    scmEmail: z.string().optional(),
    actorDisplayName: z.string().optional(),
    actorEmail: z.string().optional(),
    actorAvatarUrl: z.string().optional(),
  })
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const createMediaArtifactRequestSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  objectKey: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateMediaArtifactRequest = z.infer<typeof createMediaArtifactRequestSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  status: sessionStatusSchema,
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sendPromptResponseSchema = z.object({
  messageId: z.string().min(1),
  status: z.literal("queued").optional(),
});

export type SendPromptResponse = z.infer<typeof sendPromptResponseSchema>;

export interface ListSessionsResponse {
  sessions: Session[];
  cursor?: string;
  hasMore: boolean;
}

/** Request body for POST /sessions/:parentId/children. */
export const spawnChildSessionRequestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type SpawnChildSessionRequest = z.infer<typeof spawnChildSessionRequestSchema>;

/** Request body for POST /sessions/:parentId/children/:childId/cancel. */
export const cancelChildSessionRequestSchema = z.object({
  cancelNested: z.boolean().optional(),
});

export type CancelChildSessionRequest = z.infer<typeof cancelChildSessionRequestSchema>;

/** Returned by the child Durable Object's GET /internal/child-summary. */
export interface ChildSessionFinalResponse extends AgentResponse {
  messageId: string;
  completedAt: number | null;
  eventCount: number;
  eventLimitReached: boolean;
}

export interface ChildSessionTrajectory {
  events: EventResponse[];
  hasMore: boolean;
  cursor?: string;
  limit: number;
}

export interface ChildSessionDetail {
  session: {
    id: string;
    title: string;
    status: SessionStatus;
    repoOwner: string | null;
    repoName: string | null;
    branchName: string | null;
    model: string;
    createdAt: number;
    updatedAt: number;
  };
  sandbox: { status: SandboxStatus } | null;
  hasUnfinishedPrompt?: boolean;
  artifacts: Array<{ type: string; url: string; metadata: unknown }>;
  recentEvents: Array<{ type: string; data: unknown; createdAt: number }>;
  finalResponse?: ChildSessionFinalResponse | null;
  trajectory?: ChildSessionTrajectory;
}
