import { z } from "zod";

export const PROVIDER_ACCOUNT_USAGE_CACHE_MS = 60_000;

export const providerAccountUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    collectedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    allowed: z.boolean(),
    limitReached: z.boolean(),
    windows: z
      .array(
        z.strictObject({
          id: z.enum(["primary", "secondary"]),
          usedPercent: z.number().min(0).max(100),
          windowDurationMs: z.number().int().positive(),
          resetsAt: z.number().int().nonnegative(),
        })
      )
      .max(2),
  }),
  z.strictObject({ status: z.literal("unsupported") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum([
      "inactive_account",
      "credentials",
      "timeout",
      "provider_error",
      "invalid_response",
      "no_data",
    ]),
  }),
]);

export type ProviderAccountUsage = z.infer<typeof providerAccountUsageSchema>;
export const providerAccountUsageResponseSchema = z.strictObject({
  usage: providerAccountUsageSchema,
});
