import type { HarnessUsage } from "../harness/pricing";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { PiFeatureCapabilitySnapshot } from "@open-inspect/shared/pi-runtime-feature-capabilities";
import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import type { JsonValue } from "@earendil-works/chord";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface PiRuntimePrompt {
  sessionId: string;
  messageId: string;
  content: string;
  model: string;
  reasoningEffort?: string | null;
  /** Refuse admission when the pinned server catalog cannot price this model. */
  requirePricing?: boolean;
  /**
   * When this turn is late.
   *
   * Absolute, in milliseconds since the epoch. The session sets it to its own
   * execution budget plus the grace the recovery sweep gets, and the Durable
   * Object stops the turn when it passes — inside the object, not by waiting
   * for the sweep.
   */
  executionDeadlineMs?: number;
  /**
   * The turn's images, as metadata only.
   *
   * The bytes stay in the session's media bucket: the Pi Durable Object asks
   * the session that owns the turn for them, the way a sandbox harness asks
   * for them over the bounded media route.
   */
  attachments?: ResolvedSessionAttachment[];
}

export interface PiRuntimeReceipt {
  operationId: string;
  accepted: boolean;
  /** Definite failure before Pi admitted the operation; safe for SessionDO to settle immediately. */
  rejected?: string;
}

/**
 * The usage a turn consumed.
 *
 * The shape is the harness-neutral one: the same numbers any harness reports
 * and the control plane prices.
 */
export type PiRuntimeUsage = HarnessUsage;

export interface PiRuntimeResult {
  operationId: string;
  status: "done" | "unanswered";
  text: string;
  reason?: string;
  usage?: PiRuntimeUsage;
  /** Server-calculated from the pinned model catalog and trusted token usage. */
  costUsd: number;
}

export const piRuntimeUsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  total: z.number().nonnegative(),
}) satisfies z.ZodType<PiRuntimeUsage>;

export const piRuntimeResultSchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(["done", "unanswered"]),
  text: z.string(),
  reason: z.string().optional(),
  usage: piRuntimeUsageSchema.optional(),
  costUsd: z.number().nonnegative(),
}) satisfies z.ZodType<PiRuntimeResult>;

export type PiRuntimeOperationStatus =
  | { status: "not_found" }
  | { status: "queued" | "running" | "sleeping" | "parked" }
  | { status: "settled"; result: PiRuntimeResult };

export const piRuntimeOperationStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.enum(["queued", "running", "sleeping", "parked"]) }),
  z.object({ status: z.literal("settled"), result: piRuntimeResultSchema }),
]) satisfies z.ZodType<PiRuntimeOperationStatus>;

const controlBase = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1).max(128),
  executionDeadlineMs: z.number().int().positive().optional(),
});
const conversationId = z.number().int().positive();
const operationId = z.string().min(1).max(128);
export const piRuntimeControlSchema = z
  .discriminatedUnion("action", [
    controlBase.extend({ action: z.literal("list_conversations") }),
    controlBase.extend({ action: z.literal("get_conversation"), conversationId }),
    controlBase.extend({ action: z.literal("get_last_message"), conversationId }),
    controlBase.extend({ action: z.literal("inspect_agents") }),
    ...(["submit", "send", "follow_up"] as const).map((action) =>
      controlBase.extend({
        action: z.literal(action),
        conversationId: conversationId.optional(),
        content: z.string().min(1).max(20_000),
        model: z.string().min(1).optional(),
        reasoningEffort: z.string().nullable().optional(),
        /**
         * The operation the turn belongs to.
         *
         * The session records the turn as a message before the runtime is
         * called, so the turn's operation id is that message's id. The
         * runtime uses it for the turn, so every capability call that names
         * the operation — the credential, the projection, the events —
         * names the same one the session knows.
         */
        operationId: operationId.optional(),
      })
    ),
    controlBase.extend({
      action: z.literal("cancel_exact"),
      conversationId: conversationId.optional(),
      operationId: operationId.optional(),
      submissionId: z.number().int().positive().optional(),
      taskId: z.number().int().positive().optional(),
    }),
    controlBase.extend({
      action: z.literal("cancel_agent"),
      taskId: z.number().int().positive(),
    }),
    controlBase.extend({
      action: z.literal("retry_parked"),
      conversationId: conversationId.optional(),
    }),
    controlBase.extend({
      action: z.literal("fork"),
      conversationId,
      entryId: z.number().int().positive(),
    }),
    controlBase.extend({ action: z.literal("reset"), conversationId: conversationId.optional() }),
    controlBase.extend({
      action: z.literal("handoff"),
      conversationId: conversationId.optional(),
      handoff: z.string().min(1).max(20_000),
    }),
    controlBase.extend({
      action: z.literal("compact"),
      conversationId: conversationId.optional(),
      instructions: z.string().max(4_000).optional(),
      operationId: operationId.optional(),
    }),
    controlBase.extend({ action: z.enum(["task_graph", "inspect"]) }),
  ])
  .refine(
    (value) =>
      value.action !== "cancel_exact" ||
      value.operationId !== undefined ||
      value.submissionId !== undefined ||
      value.taskId !== undefined,
    "Exact cancel target is required"
  );
export type PiRuntimeControl = z.infer<typeof piRuntimeControlSchema>;
type PiMessageControl = Extract<PiRuntimeControl, { content: string }>;
export type PiHumanControl =
  | (PiMessageControl & { action: "send" | "follow_up" })
  | Extract<
      PiRuntimeControl,
      { action: "cancel_exact" | "retry_parked" | "fork" | "reset" | "handoff" | "compact" }
    >;
export interface PiRuntimeControlResult {
  requestId: string;
  state: "completed" | "accepted" | "indeterminate";
  result?: JsonValue;
}
export const piRuntimeControlCompletionSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  status: z.enum(["completed", "failed"]),
  costUsd: z.number().finite().nonnegative(),
  errorCode: z.string().min(1).max(128).optional(),
});
export type PiRuntimeControlCompletion = z.infer<typeof piRuntimeControlCompletionSchema>;

/** Session-scoped port for the separate Pi Durable Object namespace. */
export interface PiRuntimeDispatch {
  initialize(sessionId: string, snapshot: PiFeatureCapabilitySnapshot): Promise<void>;
  submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt>;
  lookup(sessionId: string, operationId: string): Promise<PiRuntimeOperationStatus>;
  abort(sessionId: string, operationId?: string): Promise<boolean>;
  status(sessionId: string): Promise<{ busy: boolean; pending: number }>;
  control(input: PiRuntimeControl): Promise<PiRuntimeControlResult>;
  refreshDiff(sessionId: string): Promise<void>;
  /**
   * Preserve the object's durable record for an archive.
   *
   * The archive is the promise that the record survives and that the agent is
   * done. Nothing durable is deleted: the conversation, the task graph, the
   * compaction boundaries and the workspace files stay where they are.
   */
  preserveForArchive(sessionId: string): Promise<void>;
  /** Clear the archive quiescence marker before the session becomes promptable again. */
  restoreFromArchive(sessionId: string): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}

export function toPiModel(model: string): { provider: "openai-codex"; id: string } {
  const separator = model.indexOf("/");
  if (separator < 0) return { provider: "openai-codex", id: model };
  const provider = model.slice(0, separator);
  if (provider !== "openai") throw new Error("Pi Durable requires an OpenAI model");
  return { provider: "openai-codex", id: model.slice(separator + 1) };
}

export function toPiThinkingLevel(
  effort: string | null | undefined
): ModelThinkingLevel | undefined {
  if (effort == null) return undefined;
  if ((THINKING_LEVELS as readonly string[]).includes(effort)) {
    return effort as ModelThinkingLevel;
  }
  throw new Error(`Unsupported Pi thinking level: ${effort}`);
}
