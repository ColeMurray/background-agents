import { z } from "zod";
import { sessionDiffBaselineRepositorySchema } from "./session-diffs";
import { resolvedSessionAttachmentsSchema } from "./session-attachments";
import { githubAutofixOriginSchema } from "./github-autofix";

const recordSchema = z.record(z.string(), z.unknown());
const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type GitSyncStatus = z.infer<typeof gitSyncStatusSchema>;

export const BOOT_PHASES = [
  "desktop",
  "repository_sync",
  "setup",
  "tunnel",
  "start",
  "managed_skills",
  "code_server",
  "terminal",
  "mcp_packages",
  "opencode_start",
  "opencode_health",
  "restored_session_validation",
  "git_signing",
  "bridge_initialization",
  "opencode_restart",
] as const;
export const bootPhaseSchema = z.enum(BOOT_PHASES);
export type BootPhase = z.infer<typeof bootPhaseSchema>;

export const BOOT_FAILURE_CODES = [
  "repository_boot_failed",
  "primary_start_failed",
  "managed_skills_failed",
  "opencode_start_failed",
  "opencode_health_timeout",
  "restored_session_validation_failed",
  "git_signing_failed",
  "bridge_initialization_failed",
  "fatal_phase_timeout",
  "internal_boot_error",
] as const;
export const bootFailureCodeSchema = z.enum(BOOT_FAILURE_CODES);
export type BootFailureCode = z.infer<typeof bootFailureCodeSchema>;

export const SANDBOX_EVENT_ACK_ID_MAX_LENGTH = 128;
export const BOOT_PHASE_DETAIL_CODE_MAX_LENGTH = 100;
export const BOOT_FAILURE_MESSAGE_MAX_LENGTH = 500;

const bootPhaseDetailCodeSchema = z.string().min(1).max(BOOT_PHASE_DETAIL_CODE_MAX_LENGTH);
const bootFailureAckIdSchema = z.string().min(1).max(SANDBOX_EVENT_ACK_ID_MAX_LENGTH);

const tokenUsageDetailsSchema = z
  .object({
    total: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache: z
      .object({
        read: z.number().optional(),
        write: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (usage) =>
      typeof usage.total === "number" ||
      typeof usage.input === "number" ||
      typeof usage.output === "number" ||
      typeof usage.reasoning === "number" ||
      typeof usage.cache?.read === "number" ||
      typeof usage.cache?.write === "number",
    { message: "Expected at least one token usage count" }
  );

const tokenUsageSchema = z.union([z.number(), tokenUsageDetailsSchema]);

const sandboxEventBaseSchema = z.object({
  sandboxId: z.string(),
  timestamp: z.number(),
  ackId: z.string().optional(),
});

export const sandboxBootPhaseEventSchema = sandboxEventBaseSchema.extend({
  type: z.literal("boot_phase"),
  phase: bootPhaseSchema,
  detailCode: bootPhaseDetailCodeSchema.optional(),
});
export type SandboxBootPhaseEvent = z.infer<typeof sandboxBootPhaseEventSchema>;

export const sandboxBootFailedEventSchema = sandboxEventBaseSchema.extend({
  type: z.literal("boot_failed"),
  ackId: bootFailureAckIdSchema,
  phase: bootPhaseSchema,
  code: bootFailureCodeSchema,
  message: z.string().max(BOOT_FAILURE_MESSAGE_MAX_LENGTH).optional(),
});
export type SandboxBootFailedEvent = z.infer<typeof sandboxBootFailedEventSchema>;

const messageSandboxEventBaseSchema = sandboxEventBaseSchema.extend({
  messageId: z.string(),
});

// Sandbox events from Modal or synthesized by the control plane.
export const sandboxEventSchema = z.discriminatedUnion("type", [
  sandboxBootPhaseEventSchema,
  sandboxBootFailedEventSchema,
  sandboxEventBaseSchema.extend({
    type: z.literal("heartbeat"),
    status: z.enum(["booting", "ready"]),
    phase: bootPhaseSchema.optional(),
  }),
  sandboxEventBaseSchema.extend({
    // Authoritative declaration that the current runtime connection can execute prompts.
    // Legacy runtimes emit this immediately after their late bridge connection.
    type: z.literal("ready"),
    opencodeSessionId: z.string().nullable().optional(),
    // SANDBOX_VERSION of the image this sandbox booted from. Stamped onto any
    // snapshot it produces so a later restore can be gated on it.
    runtimeVersion: z.string().optional(),
    repositories: z.array(sessionDiffBaselineRepositorySchema).optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("token"),
    content: z.string(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("tool_call"),
    tool: z.string(),
    args: recordSchema,
    callId: z.string(),
    status: z.string().optional(),
    output: z.string().optional(),
    isSubtask: z.boolean().optional(),
    childSessionId: z.string().optional(),
    taskCallId: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_start"),
    isSubtask: z.boolean().optional(),
    childSessionId: z.string().optional(),
    taskCallId: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_finish"),
    cost: z.number().optional(),
    tokens: tokenUsageSchema.optional(),
    reason: z.string().optional(),
    isSubtask: z.boolean().optional(),
    childSessionId: z.string().optional(),
    taskCallId: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("tool_result"),
    callId: z.string(),
    result: z.string(),
    error: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("git_sync"),
    status: gitSyncStatusSchema,
    sha: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("error"),
    error: z.string(),
    isSubtask: z.boolean().optional(),
    childSessionId: z.string().optional(),
    taskCallId: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("execution_complete"),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("context_compacted"),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("artifact"),
    artifactType: z.string(),
    artifactId: z.string().optional(),
    url: z.string(),
    metadata: recordSchema.optional(),
    messageId: z.string().optional(),
  }),
  // Push events: repoOwner/repoName identify the repository in a multi-repo
  // session (absent means the session's sole repo). branchName is optional
  // because legacy runtimes emit a key-less push_error on the
  // "no repository found" path — requiring it would drop that event at the
  // parse layer and leak the pending push resolver.
  z.object({
    type: z.literal("push_complete"),
    branchName: z.string().optional(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push_error"),
    branchName: z.string().optional(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    error: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  // Non-fatal boot/runtime warnings (secondary setup/start failures,
  // .opencode assembly collisions, secrets collisions). Live ingest drops
  // unknown union entries, so this entry must exist before runtimes emit it.
  z.object({
    type: z.literal("warning"),
    scope: z.enum(["sync", "setup", "start", "assembly", "secrets", "media"]),
    message: z.string(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("session_title"),
    title: z.string(),
  }),
  z.object({
    type: z.literal("user_message"),
    content: z.string(),
    messageId: z.string(),
    timestamp: z.number(),
    ackId: z.string().optional(),
    author: z
      .object({
        participantId: z.string(),
        userId: z.string().optional(),
        name: z.string(),
        avatar: z.string().optional(),
      })
      .optional(),
    // Attachment metadata only — never inline content, which would bloat the
    // events table and every broadcast. attachmentId lets clients stream attachments.
    attachments: resolvedSessionAttachmentsSchema.optional(),
    origin: githubAutofixOriginSchema.optional(),
  }),
]);

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;
export type EventType = SandboxEvent["type"];

export interface AgentEvent {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

type ToolCallIdentityEvent = Pick<
  Extract<SandboxEvent, { type: "tool_call" }>,
  "messageId" | "callId" | "isSubtask" | "childSessionId" | "taskCallId"
>;

export function toolCallIdentityTuple(
  event: ToolCallIdentityEvent
): readonly [messageId: string, scope: string, callId: string] {
  const scope = event.isSubtask
    ? event.childSessionId || event.taskCallId || "unassociated-subtask"
    : "parent";
  return [event.messageId, scope, event.callId];
}

export function toolCallIdentityKey(event: ToolCallIdentityEvent): string {
  return JSON.stringify(toolCallIdentityTuple(event));
}

/**
 * Runtime companion to `EventType`: the enum is derived from the canonical
 * `sandboxEventSchema` discriminator values, so it can never drift from the
 * event union that owns the contract.
 */
export const eventTypeSchema = z.enum(
  sandboxEventSchema.options.map((option) => option.shape.type.value) as [EventType, ...EventType[]]
);

export const eventResponseSchema = z.object({
  id: z.string(),
  type: eventTypeSchema,
  data: recordSchema,
  messageId: z.string().nullable(),
  createdAt: z.number(),
});

/**
 * Pagination invariant: a page that reports more results must carry the cursor
 * needed to fetch them. Consumers stop paginating when `cursor` is absent, so a
 * `hasMore: true` page without a cursor would silently truncate the history and
 * can produce a false completion from partial events.
 */
export const listEventsResponseSchema = z
  .object({
    events: z.array(eventResponseSchema),
    cursor: z.string().min(1).optional(),
    hasMore: z.boolean(),
  })
  .refine((page) => !page.hasMore || page.cursor !== undefined, {
    message: "cursor is required when hasMore is true",
    path: ["cursor"],
  });

export type EventResponse = z.infer<typeof eventResponseSchema>;
export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>;
