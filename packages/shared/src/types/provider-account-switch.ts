import { z } from "zod";
import {
  modelProviderAccountIdSchema,
  sessionModelProviderAuthSchema,
  subscriptionProviderIdSchema,
} from "./provider-accounts";
import { sandboxShutdownSchema } from "./sandbox-shutdown";

const operationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const providerSwitchGenerationSchema = z.strictObject({
  sandboxId: z.string().min(1).max(256),
  createdAt: z.number().int().nonnegative(),
});
export const providerAccountSwitchRequestSchema = z.strictObject({
  operationId,
  targetAccountId: modelProviderAccountIdSchema,
  expectedBindingRevision: z.number().int().positive(),
});
export type ProviderAccountSwitchRequest = z.infer<typeof providerAccountSwitchRequestSchema>;
export const providerAccountSwitchIdentitySchema = z.object({
  operationId,
  provider: subscriptionProviderIdSchema,
  bindingRevision: z.number().int().positive(),
  generation: providerSwitchGenerationSchema,
  conversationId: z.string().min(1).max(256),
});
export const providerAccountSwitchEventSchema = providerAccountSwitchIdentitySchema.extend({
  timestamp: z.number().optional(),
  type: z.literal("provider_account_switch"),
  outcome: z.enum(["quiesced", "applied", "failed"]),
  reason: z
    .enum([
      "stop_not_confirmed",
      "credential_unavailable",
      "conversation_unavailable",
      "apply_outcome_unknown",
    ])
    .optional(),
});
export type ProviderAccountSwitchEvent = z.infer<typeof providerAccountSwitchEventSchema>;
export const providerAccountSwitchOperationSchema = providerAccountSwitchIdentitySchema.extend({
  actorId: z.string().min(1),
  sourceAccountId: modelProviderAccountIdSchema,
  targetAccountId: modelProviderAccountIdSchema,
  expectedBindingRevision: z.number().int().positive(),
  phase: z.enum([
    "validating",
    "restoring",
    "quiescing",
    "applying",
    "applied",
    "needs_reconciliation",
    "failed",
    "cancelled",
  ]),
  deadlineMs: z.number().int().nonnegative(),
  hold: z.boolean(),
  interrupted: z.boolean(),
  reason: z
    .enum([
      "stop_not_confirmed",
      "credential_unavailable",
      "conversation_unavailable",
      "apply_outcome_unknown",
      "workspace_unavailable",
      "deadline_expired",
      "ineligible_target",
      "preservation_unavailable",
    ])
    .optional(),
});
export type ProviderAccountSwitchOperation = z.infer<typeof providerAccountSwitchOperationSchema>;
export const sessionProviderAuthStateSchema = z.object({
  bindings: z.array(sessionModelProviderAuthSchema).max(3),
  operation: providerAccountSwitchOperationSchema.nullable(),
  switchAvailable: z.boolean(),
  unavailableReason: z.string().max(256).optional(),
  pendingCount: z.number().int().nonnegative(),
  preservation: sandboxShutdownSchema.nullable().optional(),
});
export type SessionProviderAuthState = z.infer<typeof sessionProviderAuthStateSchema>;
export const providerAccountResumeRequestSchema = z.strictObject({
  operationId,
  bindingRevision: z.number().int().positive(),
});
export const providerAccountSwitchCommandSchema = providerAccountSwitchIdentitySchema.extend({
  type: z.enum(["provider_account_quiesce", "provider_account_apply"]),
  deadlineMs: z.number().int().nonnegative(),
  model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(32).nullable(),
});
export type ProviderAccountSwitchCommand = z.infer<typeof providerAccountSwitchCommandSchema>;
