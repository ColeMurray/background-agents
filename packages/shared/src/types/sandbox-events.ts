import { z } from "zod";
import { harnessIdSchema } from "../harnesses";
import { sessionDiffBaselineRepositorySchema } from "./session-diffs";
import { resolvedSessionAttachmentsSchema } from "./session-attachments";
import { githubAutofixOriginSchema } from "./github-autofix";

const recordSchema = z.record(z.string(), z.unknown());
const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type GitSyncStatus = z.infer<typeof gitSyncStatusSchema>;

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

/** The steps of a sandbox boot, in the order the supervisor runs them. */
export const bootPhaseNameSchema = z.enum([
  "starting",
  "sync",
  "setup",
  "start",
  "skills",
  "harness",
]);
export type BootPhaseName = z.infer<typeof bootPhaseNameSchema>;

export const bootPhaseStatusSchema = z.enum(["started", "completed", "failed"]);
export type BootPhaseStatus = z.infer<typeof bootPhaseStatusSchema>;

/**
 * The byte budget for a `sandbox-error` report as the public route accepts it.
 * One contract for the sender, the route cap and the tail bounds below: a
 * report valid at the schema must fit through the route.
 */
export const SANDBOX_ERROR_BODY_MAX_BYTES = 32 * 1024;
/** Most lines a boot failure's output tail may carry. */
export const SANDBOX_OUTPUT_TAIL_MAX_LINES = 60;
/** Most characters an output tail may carry across all its lines. */
export const SANDBOX_OUTPUT_TAIL_MAX_CHARS = 8 * 1024;

/**
 * The last lines of a failing boot script, bounded and redacted by the
 * runtime before they leave the sandbox and bounded again here. Sized so a
 * full tail, JSON-escaped, fits inside SANDBOX_ERROR_BODY_MAX_BYTES with
 * room for the rest of the report.
 */
export const sandboxOutputTailSchema = z
  .array(z.string().max(1024))
  .max(SANDBOX_OUTPUT_TAIL_MAX_LINES)
  .refine(
    (lines) =>
      lines.reduce((total, line) => total + line.length, 0) <= SANDBOX_OUTPUT_TAIL_MAX_CHARS,
    { message: `output tail exceeds ${SANDBOX_OUTPUT_TAIL_MAX_CHARS} characters` }
  );

/**
 * The latest `boot_progress` report of a booting sandbox, as the control
 * plane stores it and the subscribe snapshot carries it: the same fields
 * the event has, minus the envelope. Present while the sandbox boots and
 * after a boot failed (naming the step that broke, with the script's
 * output tail); cleared at ready. `sandboxId` identifies the boot that
 * reported, the same identity every `boot_progress` event carries.
 */
export const sandboxBootPhaseSchema = z.object({
  phase: bootPhaseNameSchema,
  status: bootPhaseStatusSchema,
  bootSeq: z.number().int().optional(),
  sandboxId: z.string().optional(),
  warning: z.boolean().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  elapsedMs: z.number().optional(),
  outputTail: sandboxOutputTailSchema.optional(),
  detail: z.string().optional(),
});
export type SandboxBootPhase = z.infer<typeof sandboxBootPhaseSchema>;

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
    // Emitted on every sandbox bridge connect (bridge readiness, not vendor
    // readiness). Present in essentially every session's replay history.
    type: z.literal("ready"),
    opencodeSessionId: z.string().nullable().optional(),
    /** Which harness the runtime booted; the session DO warns when it differs from the session's. */
    harness: harnessIdSchema.optional(),
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
    /** Cost of this step alone; absent when the runtime could not price it. */
    cost: z.number().nullable().optional(),
    /** Cumulative reported cost of the whole turn so far; idempotent on resend. */
    messageCostUsd: z.number().nonnegative().optional(),
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
    /** Final cumulative reported cost of the turn. */
    messageCostUsd: z.number().nonnegative().optional(),
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
    scope: z.enum(["sync", "setup", "start", "assembly", "secrets", "media", "budget", "provider"]),
    message: z.string(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  // Boot phase reports from the sandbox supervisor, relayed by the bridge
  // while it is connected ahead of the harness. `bootSeq` is monotonic per
  // boot so a phase resent after a reconnect can be recognised. Informational:
  // the control plane never gates admission on a phase, only names it. Live
  // ingest drops unknown union entries, so this entry must exist before
  // runtimes emit it.
  z.object({
    type: z.literal("boot_progress"),
    bootSeq: z.number().int(),
    phase: bootPhaseNameSchema,
    status: bootPhaseStatusSchema,
    /** A non-fatal hook exit was tolerated (setup.sh outside an image build). */
    warning: z.boolean().optional(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
    elapsedMs: z.number().optional(),
    /** Last lines of the failing script, bounded and redacted by the runtime. */
    outputTail: sandboxOutputTailSchema.optional(),
    detail: z.string().optional(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("session_title"),
    title: z.string(),
  }),
  // The bridge's answer to the `snapshot` command; carries the agent session
  // id so the snapshot can be resumed. Critical (ack'd) on the bridge side.
  sandboxEventBaseSchema.extend({
    type: z.literal("snapshot_ready"),
    opencodeSessionId: z.string().nullable().optional(),
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

export type BootProgressEvent = Extract<SandboxEvent, { type: "boot_progress" }>;

/** The boot phase a `boot_progress` event reports: the event without its envelope. */
export function toSandboxBootPhase(event: BootProgressEvent): SandboxBootPhase {
  const { type: _type, timestamp: _timestamp, ackId: _ackId, ...phase } = event;
  return phase;
}

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
