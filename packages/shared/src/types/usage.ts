import type { HarnessId } from "../harnesses";
import type { TokenUsage } from "./sandbox-events";

export interface NormalizedTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

export interface StepUsage extends NormalizedTokenUsage {
  id: string;
  messageId: string | null;
  model: string | null;
  harness: HarnessId | null;
  stepCostUsd: number | null;
  messageCostUsd: number | null;
  isSubtask: boolean;
  childSessionId: string | null;
  taskCallId: string | null;
  reason: string | null;
  createdAt: number;
}

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
