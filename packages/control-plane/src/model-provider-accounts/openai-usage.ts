import { z } from "zod";
import {
  PROVIDER_ACCOUNT_USAGE_CACHE_MS,
  type ProviderAccountUsage,
} from "@open-inspect/shared/types/provider-account-usage";

// Wire contract pinned to openai/codex 922510f4d7570b42838e015787ed53abfa8761a1.
// See test/fixtures/provider-usage/README.md for official sources and fixture provenance.
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const windowSchema = z.object({
  used_percent: z.number().int().min(0).max(100),
  limit_window_seconds: z.number().int().positive().max(2_147_483_647),
  reset_after_seconds: z.number().int().nonnegative(),
  reset_at: z.number().int().nonnegative().max(2_147_483_647),
});
const payloadSchema = z.object({
  rate_limit: z
    .object({
      allowed: z.boolean(),
      limit_reached: z.boolean(),
      primary_window: windowSchema.nullish(),
      secondary_window: windowSchema.nullish(),
    })
    .nullish(),
});

export function parseOpenAIUsage(payload: unknown, collectedAt: number): ProviderAccountUsage {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return { status: "unavailable", reason: "invalid_response" };
  const limit = parsed.data.rate_limit;
  if (!limit) return { status: "unavailable", reason: "no_data" };
  const windows: Extract<ProviderAccountUsage, { status: "available" }>["windows"] = [];
  for (const id of ["primary", "secondary"] as const) {
    const window = limit[`${id}_window`];
    if (window)
      windows.push({
        id,
        usedPercent: window.used_percent,
        windowDurationMs: window.limit_window_seconds * 1000,
        resetsAt: window.reset_at * 1000,
      });
  }
  return {
    status: "available",
    collectedAt,
    // Never reuse a pre-reset observation after its window resets.
    expiresAt: Math.min(
      collectedAt + PROVIDER_ACCOUNT_USAGE_CACHE_MS,
      ...windows.filter((window) => window.resetsAt > collectedAt).map((window) => window.resetsAt)
    ),
    allowed: limit.allowed,
    limitReached: limit.limit_reached,
    windows,
  };
}
