import { z } from "zod";
import {
  modelProviderAccountIdSchema,
  providerAuthModeSchema,
  subscriptionProviderIdSchema,
} from "./provider-accounts";

export const MAX_PROVIDER_ACCOUNT_POOL_SIZE = 100;
const poolSchema = z
  .array(modelProviderAccountIdSchema)
  .min(1)
  .max(MAX_PROVIDER_ACCOUNT_POOL_SIZE)
  .refine((ids) => new Set(ids).size === ids.length, "Account pool must not contain duplicates");
const policySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("fixed"), accountId: modelProviderAccountIdSchema }),
  z.strictObject({ mode: z.literal("random"), accountIds: poolSchema }),
  z.strictObject({ mode: z.literal("unconfigured") }),
]);
export const providerAccountRoutingRequestSchema = z.strictObject({
  expectedPolicyRevision: z.number().int().nonnegative(),
  selection: policySchema,
  unattendedMode: providerAuthModeSchema,
});
export type ProviderAccountRoutingRequest = z.infer<typeof providerAccountRoutingRequestSchema>;
export const providerAccountRoutingSchema = z.strictObject({
  provider: subscriptionProviderIdSchema,
  policyRevision: z.number().int().nonnegative(),
  selection: policySchema,
  unattendedMode: providerAuthModeSchema,
});
export type ProviderAccountRouting = z.infer<typeof providerAccountRoutingSchema>;
export const providerAccountRoutingResponseSchema = z.strictObject({
  policies: z.array(providerAccountRoutingSchema).max(3),
});
