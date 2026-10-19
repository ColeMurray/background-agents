import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { PiFeatureCapabilitySnapshot } from "@open-inspect/shared/pi-feature-capabilities";
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
}

export interface PiRuntimeReceipt {
  operationId: string;
  accepted: boolean;
  /** Definite failure before Pi admitted the operation; safe for SessionDO to settle immediately. */
  rejected?: string;
}

export interface PiRuntimeUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

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
  | { status: "queued" }
  | { status: "running" }
  | { status: "settled"; result: PiRuntimeResult };

export const piRuntimeOperationStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("running") }),
  z.object({ status: z.literal("settled"), result: piRuntimeResultSchema }),
]) satisfies z.ZodType<PiRuntimeOperationStatus>;

const controlBase = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1).max(128),
});
const conversationId = z.number().int().positive();
const operationId = z.string().min(1).max(128);
export const piRuntimeControlSchema = z
  .discriminatedUnion("action", [
    controlBase.extend({ action: z.literal("list_conversations") }),
    controlBase.extend({ action: z.literal("get_conversation"), conversationId }),
    controlBase.extend({ action: z.literal("get_last_message"), conversationId }),
    controlBase.extend({ action: z.literal("inspect_agents") }),
    controlBase.extend({
      action: z.enum(["submit", "send", "steer", "follow_up"]),
      conversationId: conversationId.optional(),
      content: z.string().min(1).max(20_000),
      model: z.string().min(1).optional(),
      reasoningEffort: z.string().nullable().optional(),
    }),
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
