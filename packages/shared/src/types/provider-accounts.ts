import { z } from "zod";

export const SUBSCRIPTION_PROVIDER_IDS = ["openai", "xai"] as const;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];

export const SUBSCRIPTION_PROVIDER_DISPLAY_METADATA = {
  openai: { displayName: "OpenAI", subscriptionName: "ChatGPT" },
  xai: { displayName: "xAI", subscriptionName: "SuperGrok" },
} as const satisfies Readonly<
  Record<SubscriptionProviderId, { displayName: string; subscriptionName: string }>
>;

export const subscriptionProviderIdSchema = z.enum(SUBSCRIPTION_PROVIDER_IDS);

/** Provider account IDs use the installation's canonical 16-byte hex ID format. */
export const MODEL_PROVIDER_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const modelProviderAccountIdSchema = z.string().regex(MODEL_PROVIDER_ACCOUNT_ID_PATTERN);

/** Device authorization transaction IDs use 32 random bytes encoded as lowercase hex. */
export const PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN = /^[0-9a-f]{64}$/;
export const providerDeviceAuthorizationIdSchema = z
  .string()
  .regex(PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN);

export const providerAuthSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("provider_account"),
    accountId: modelProviderAccountIdSchema,
  }),
  z.strictObject({ mode: z.literal("api_key") }),
]);
export type ProviderAuthSelection = z.infer<typeof providerAuthSelectionSchema>;
export const providerAuthModeSchema = z.enum(["provider_account", "api_key"]);
export type ProviderAuthMode = z.infer<typeof providerAuthModeSchema>;
export type SessionProviderAuthMode = ProviderAuthMode | "legacy_scoped_oauth";

/** Closed, bounded map: one optional selection for each supported subscription provider. */
export const modelProviderSelectionsSchema = z.strictObject({
  openai: providerAuthSelectionSchema.optional(),
  xai: providerAuthSelectionSchema.optional(),
});
export type ModelProviderSelections = z.infer<typeof modelProviderSelectionsSchema>;

export const modelProviderAccountStatusSchema = z.enum([
  "active",
  "disabled",
  "reconnect_required",
]);
export type ModelProviderAccountStatus = z.infer<typeof modelProviderAccountStatusSchema>;

export const modelProviderAccountSchema = z.strictObject({
  id: modelProviderAccountIdSchema,
  provider: subscriptionProviderIdSchema,
  displayName: z.string().min(1).max(100),
  externalAccountId: z.string().min(1).nullable(),
  status: modelProviderAccountStatusSchema,
  createdBy: z.string().min(1).nullable(),
  updatedBy: z.string().min(1).nullable(),
  lastVerifiedAt: z.number().int().nonnegative().nullable(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
});
export type ModelProviderAccount = z.infer<typeof modelProviderAccountSchema>;

export type ModelProviderAccountReconnectMethod = "device_authorization" | "refresh_token";

/**
 * Canonical reconnect capability for provider accounts.
 *
 * xAI accounts created before device authorization do not have a bound external identity and
 * retain the one-time refresh-token reconnect path. Keep that compatibility rule here rather
 * than making clients infer a workflow from account metadata independently.
 */
export function modelProviderAccountReconnectMethod(
  account: Pick<ModelProviderAccount, "provider" | "externalAccountId">
): ModelProviderAccountReconnectMethod {
  return account.provider === "xai" && account.externalAccountId === null
    ? "refresh_token"
    : "device_authorization";
}

export const modelProviderAccountResponseSchema = z.strictObject({
  account: modelProviderAccountSchema,
});
export type ModelProviderAccountResponse = z.infer<typeof modelProviderAccountResponseSchema>;

export const createModelProviderAccountResponseSchema = z.strictObject({
  account: modelProviderAccountSchema,
  reconnectedExisting: z.boolean(),
});
export type CreateModelProviderAccountResponse = z.infer<
  typeof createModelProviderAccountResponseSchema
>;

export const modelProviderAccountsResponseSchema = z.strictObject({
  accounts: z.array(modelProviderAccountSchema),
});
export type ModelProviderAccountsResponse = z.infer<typeof modelProviderAccountsResponseSchema>;

export const modelProviderAccountDefaultSchema = z.strictObject({
  provider: subscriptionProviderIdSchema,
  providerAccountId: modelProviderAccountIdSchema,
  unattendedMode: providerAuthModeSchema,
  createdBy: z.string().min(1).nullable(),
  updatedBy: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ModelProviderAccountDefault = z.infer<typeof modelProviderAccountDefaultSchema>;

export const modelProviderAccountDefaultResponseSchema = z.strictObject({
  default: modelProviderAccountDefaultSchema,
});
export type ModelProviderAccountDefaultResponse = z.infer<
  typeof modelProviderAccountDefaultResponseSchema
>;

export const modelProviderAccountDefaultRequestSchema = z.strictObject({
  providerAccountId: modelProviderAccountIdSchema,
  unattendedMode: providerAuthModeSchema,
});

export const modelProviderAccountDefaultsResponseSchema = z.strictObject({
  defaults: z.array(modelProviderAccountDefaultSchema).max(SUBSCRIPTION_PROVIDER_IDS.length),
});
export type ModelProviderAccountDefaultsResponse = z.infer<
  typeof modelProviderAccountDefaultsResponseSchema
>;

const sessionModelProviderAuthRoutingSchema = {
  selectionSource: z.string().min(1),
} as const;

export const sessionModelProviderAuthSchema = z.discriminatedUnion("authMode", [
  z.strictObject({
    provider: subscriptionProviderIdSchema,
    authMode: z.literal("provider_account"),
    providerAccountId: modelProviderAccountIdSchema,
    ...sessionModelProviderAuthRoutingSchema,
  }),
  z.strictObject({
    provider: subscriptionProviderIdSchema,
    authMode: z.literal("api_key"),
    ...sessionModelProviderAuthRoutingSchema,
  }),
  z.strictObject({
    provider: subscriptionProviderIdSchema,
    authMode: z.literal("legacy_scoped_oauth"),
    ...sessionModelProviderAuthRoutingSchema,
  }),
]);
export type SessionModelProviderAuth = z.infer<typeof sessionModelProviderAuthSchema>;

export const sessionModelProviderAuthResponseSchema = z.strictObject({
  providerAuth: z.array(sessionModelProviderAuthSchema).max(SUBSCRIPTION_PROVIDER_IDS.length),
});
export type SessionModelProviderAuthResponse = z.infer<
  typeof sessionModelProviderAuthResponseSchema
>;

export const legacyProviderKeyLocationSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("global"), key: z.string() }),
  z.strictObject({
    scope: z.literal("repository"),
    scopeId: z.string(),
    repository: z.string(),
    key: z.string(),
  }),
  z.strictObject({ scope: z.literal("environment"), scopeId: z.string(), key: z.string() }),
]);
export type LegacyProviderKeyLocation = z.infer<typeof legacyProviderKeyLocationSchema>;

export const legacyProviderCredentialsResponseSchema = z.strictObject({
  legacyKeys: z.array(legacyProviderKeyLocationSchema),
});
export type LegacyProviderCredentialsResponse = z.infer<
  typeof legacyProviderCredentialsResponseSchema
>;

export const modelProviderAccountDisplayNameSchema = z.string().trim().min(1).max(100);
const credentialStringSchema = z.string().min(1).max(65_536);
const externalAccountIdSchema = z.string().trim().min(1).max(512);

export const connectOpenAIModelProviderAccountRequestSchema = z.strictObject({
  provider: z.literal("openai"),
  displayName: modelProviderAccountDisplayNameSchema,
  refreshToken: credentialStringSchema,
  accountId: externalAccountIdSchema,
});
export const connectXaiModelProviderAccountRequestSchema = z.strictObject({
  provider: z.literal("xai"),
  displayName: modelProviderAccountDisplayNameSchema,
  refreshToken: credentialStringSchema,
});
export const connectModelProviderAccountRequestSchema = z.discriminatedUnion("provider", [
  connectOpenAIModelProviderAccountRequestSchema,
  connectXaiModelProviderAccountRequestSchema,
]);
export type ConnectModelProviderAccountRequest = z.infer<
  typeof connectModelProviderAccountRequestSchema
>;

export const reconnectOpenAIModelProviderAccountRequestSchema = z.strictObject({
  provider: z.literal("openai"),
  refreshToken: credentialStringSchema,
  accountId: externalAccountIdSchema,
});
export const reconnectXaiModelProviderAccountRequestSchema = z.strictObject({
  provider: z.literal("xai"),
  refreshToken: credentialStringSchema,
});
export const reconnectModelProviderAccountRequestSchema = z.discriminatedUnion("provider", [
  reconnectOpenAIModelProviderAccountRequestSchema,
  reconnectXaiModelProviderAccountRequestSchema,
]);
export type ReconnectModelProviderAccountRequest = z.infer<
  typeof reconnectModelProviderAccountRequestSchema
>;

export const startProviderDeviceAuthorizationRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    displayName: modelProviderAccountDisplayNameSchema,
  }),
  z.strictObject({
    operation: z.literal("reconnect"),
    providerAccountId: modelProviderAccountIdSchema,
  }),
]);
export type StartProviderDeviceAuthorizationRequest = z.infer<
  typeof startProviderDeviceAuthorizationRequestSchema
>;

export const startProviderDeviceAuthorizationResponseSchema = z.strictObject({
  transactionId: providerDeviceAuthorizationIdSchema,
  provider: subscriptionProviderIdSchema,
  operation: z.enum(["create", "reconnect"]),
  userCode: z.string().min(1).max(128),
  verificationUrl: z.url(),
  expiresAt: z.number().int().positive(),
  expiresInMs: z.number().int().positive(),
  pollIntervalMs: z.number().int().min(1_000).max(60_000),
});
export type StartProviderDeviceAuthorizationResponse = z.infer<
  typeof startProviderDeviceAuthorizationResponseSchema
>;

const pendingProviderDeviceAuthorizationSchema = z.strictObject({
  status: z.literal("pending"),
  expiresAt: z.number().int().positive(),
  pollIntervalMs: z.number().int().min(1_000).max(60_000),
  nextPollAt: z.number().int().positive(),
});

const terminalProviderDeviceAuthorizationErrorSchema = z.strictObject({
  status: z.enum(["denied", "expired", "failed", "cancelled", "superseded"]),
  error: z.string().min(1).max(512),
  retryable: z.boolean(),
});

export const providerDeviceAuthorizationStatusResponseSchema = z.discriminatedUnion("status", [
  pendingProviderDeviceAuthorizationSchema,
  z.strictObject({
    status: z.literal("connected"),
    account: modelProviderAccountSchema,
    reconnectedExisting: z.boolean(),
    completedAt: z.number().int().positive(),
  }),
  terminalProviderDeviceAuthorizationErrorSchema,
]);
export type ProviderDeviceAuthorizationStatusResponse = z.infer<
  typeof providerDeviceAuthorizationStatusResponseSchema
>;
