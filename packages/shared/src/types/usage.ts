import { z } from "zod";
import { harnessIdSchema } from "../harnesses";
import type { TokenUsage } from "./sandbox-events";

export interface NormalizedTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

export const stepUsageSchema = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  model: z.string().nullable(),
  harness: harnessIdSchema.nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  stepCostUsd: z.number().nullable(),
  messageCostUsd: z.number().nullable(),
  isSubtask: z.boolean(),
  childSessionId: z.string().nullable(),
  taskCallId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number(),
});
export type StepUsage = z.infer<typeof stepUsageSchema>;

export function normalizeTokenUsage(tokens: TokenUsage | undefined): NormalizedTokenUsage {
  const count = (value: number | undefined): number | null =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;

  const details = typeof tokens === "object" ? tokens : undefined;
  const inputTokens = count(details?.input);
  const outputTokens = count(details?.output);
  const reasoningTokens = count(details?.reasoning);
  const cacheReadTokens = count(details?.cache?.read);
  const cacheWriteTokens = count(details?.cache?.write);
  const parts = [inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens];
  const reportedTotal = count(typeof tokens === "number" ? tokens : details?.total);
  const summedParts = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: reportedTotal ?? (parts.some((part) => part !== null) ? count(summedParts) : null),
  };
}
