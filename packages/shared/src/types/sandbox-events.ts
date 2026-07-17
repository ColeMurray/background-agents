import { z } from "zod";
import { recordSchema } from "./artifacts";
import { sessionDiffBaselineRepositorySchema } from "./session-diffs";
import { gitSyncStatusSchema, type EventType } from "./statuses";
import { resolvedSessionAttachmentsSchema } from "./session-attachments";

export interface AgentEvent {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

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

const messageSandboxEventBaseSchema = sandboxEventBaseSchema.extend({
  messageId: z.string(),
});

// Sandbox events from Modal or synthesized by the control plane.
export const sandboxEventSchema = z.discriminatedUnion("type", [
  sandboxEventBaseSchema.extend({
    type: z.literal("heartbeat"),
    status: z.string(),
  }),
  sandboxEventBaseSchema.extend({
    // Emitted once when the sandbox bridge connects and OpenCode is ready.
    // Present in essentially every session's replay history.
    type: z.literal("ready"),
    opencodeSessionId: z.string().nullable().optional(),
    capabilities: z.array(z.string()).optional(),
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
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_start"),
    isSubtask: z.boolean().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_finish"),
    cost: z.number().optional(),
    tokens: tokenUsageSchema.optional(),
    reason: z.string().optional(),
    isSubtask: z.boolean().optional(),
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
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("execution_complete"),
    success: z.boolean(),
    error: z.string().optional(),
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
        name: z.string(),
        avatar: z.string().optional(),
      })
      .optional(),
    // Attachment metadata only — never inline content, which would bloat the
    // events table and every broadcast. attachmentId lets clients stream attachments.
    attachments: resolvedSessionAttachmentsSchema.optional(),
  }),
]);

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;

/**
 * Sandbox event arrays for session hydration — both the initial `subscribed`
 * replay and paginated `history_page` items, which read from the same event
 * store. Resilient to unknown/legacy event shapes: each event is validated
 * individually and dropped if it doesn't match, instead of failing the whole
 * message. A single unrecognized event must never wedge session hydration and
 * strand the client on "loading session" forever.
 */
export const tolerantSandboxEventsSchema = z.array(z.unknown()).transform((events) =>
  events.flatMap((event) => {
    const result = sandboxEventSchema.safeParse(event);
    return result.success ? [result.data] : [];
  })
);

export interface EventResponse {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventsResponse {
  events: EventResponse[];
  cursor?: string;
  hasMore: boolean;
}
