import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface PiRuntimePrompt {
  sessionId: string;
  messageId: string;
  content: string;
  model: string;
  reasoningEffort?: string | null;
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
}) satisfies z.ZodType<PiRuntimeResult>;

/** Session-scoped port for the separate Pi Durable Object namespace. */
export interface PiRuntimeDispatch {
  submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt>;
  abort(sessionId: string, operationId?: string): Promise<boolean>;
  status(sessionId: string): Promise<{ busy: boolean; pending: number }>;
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
