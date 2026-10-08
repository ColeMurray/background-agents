import { z } from "zod";

export const SUBSCRIPTION_PROVIDER_IDS = ["openai", "xai", "anthropic"] as const;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];

export const SUBSCRIPTION_PROVIDER_DISPLAY_METADATA = {
  openai: { displayName: "OpenAI", subscriptionName: "ChatGPT" },
  xai: { displayName: "xAI", subscriptionName: "SuperGrok" },
  anthropic: { displayName: "Anthropic", subscriptionName: "Claude" },
} as const satisfies Readonly<
  Record<SubscriptionProviderId, { displayName: string; subscriptionName: string }>
>;

export const subscriptionProviderIdSchema = z.enum(SUBSCRIPTION_PROVIDER_IDS);

/**
 * How a provider account is connected from Settings. Device authorization
 * polls the provider for a user-code approval; authorization code sends the
 * user to the provider's consent page and takes the code it shows back
 * (Anthropic's hosted callback displays the code for the user to paste).
 */
export type ModelProviderAccountConnectionMethod = "device_authorization" | "authorization_code";
export const MODEL_PROVIDER_ACCOUNT_CONNECTION_METHOD = {
  openai: "device_authorization",
  xai: "device_authorization",
  anthropic: "authorization_code",
} as const satisfies Readonly<Record<SubscriptionProviderId, ModelProviderAccountConnectionMethod>>;

export function modelProviderAccountConnectionMethod(
  provider: SubscriptionProviderId
): ModelProviderAccountConnectionMethod {
  return MODEL_PROVIDER_ACCOUNT_CONNECTION_METHOD[provider];
}

/**
 * Providers whose stored credential never refreshes: the token is what the
 * runtime receives (a Claude setup token). Verification against the provider
 * is not offered for them.
 */
export const STATIC_CREDENTIAL_PROVIDER_IDS: readonly SubscriptionProviderId[] = ["anthropic"];

/** Provider account IDs use the installation's canonical 16-byte hex ID format. */
export const MODEL_PROVIDER_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const modelProviderAccountIdSchema = z.string().regex(MODEL_PROVIDER_ACCOUNT_ID_PATTERN);

/** Device authorization transaction IDs use 32 random bytes encoded as lowercase hex. */
export const PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN = /^[0-9a-f]{64}$/;
export const PROVIDER_DEVICE_AUTHORIZATION_MIN_POLL_INTERVAL_MS = 1_000;
export const PROVIDER_DEVICE_AUTHORIZATION_MAX_POLL_INTERVAL_MS = 60_000;
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
  anthropic: providerAuthSelectionSchema.optional(),
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

export type ModelProviderAccountReconnectMethod =
  | "device_authorization"
  | "authorization_code"
  | "refresh_token";

/**
 * Canonical reconnect capability for provider accounts.
 *
 * The provider declares its connection method; the one compatibility rule is
 * that xAI accounts created before device authorization have no bound
 * external identity and keep the one-time refresh-token reconnect path.
 * Anthropic accounts are identity-less by design (the inference scope carries
 * no account id) and always reconnect through the authorization-code flow.
 */
export function modelProviderAccountReconnectMethod(
  account: Pick<ModelProviderAccount, "provider" | "externalAccountId">
): ModelProviderAccountReconnectMethod {
  if (account.provider === "xai" && account.externalAccountId === null) return "refresh_token";
  return modelProviderAccountConnectionMethod(account.provider);
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
/** Direct connect with a token minted elsewhere (`claude setup-token` on a workstation). */
export const connectAnthropicModelProviderAccountRequestSchema = z.strictObject({
  provider: z.literal("anthropic"),
  displayName: modelProviderAccountDisplayNameSchema,
  setupToken: credentialStringSchema,
});
export const connectModelProviderAccountRequestSchema = z.discriminatedUnion("provider", [
  connectOpenAIModelProviderAccountRequestSchema,
  connectXaiModelProviderAccountRequestSchema,
  connectAnthropicModelProviderAccountRequestSchema,
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
export const reconnectAnthropicModelProviderAccountRequestSchema = z.strictObject({
  provider: z.literal("anthropic"),
  setupToken: credentialStringSchema,
});
export const reconnectModelProviderAccountRequestSchema = z.discriminatedUnion("provider", [
  reconnectOpenAIModelProviderAccountRequestSchema,
  reconnectXaiModelProviderAccountRequestSchema,
  reconnectAnthropicModelProviderAccountRequestSchema,
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
  pollIntervalMs: z
    .number()
    .int()
    .min(PROVIDER_DEVICE_AUTHORIZATION_MIN_POLL_INTERVAL_MS)
    .max(PROVIDER_DEVICE_AUTHORIZATION_MAX_POLL_INTERVAL_MS),
});
export type StartProviderDeviceAuthorizationResponse = z.infer<
  typeof startProviderDeviceAuthorizationResponseSchema
>;

const pendingProviderDeviceAuthorizationSchema = z.strictObject({
  status: z.literal("pending"),
  expiresAt: z.number().int().positive(),
  pollIntervalMs: z
    .number()
    .int()
    .min(PROVIDER_DEVICE_AUTHORIZATION_MIN_POLL_INTERVAL_MS)
    .max(PROVIDER_DEVICE_AUTHORIZATION_MAX_POLL_INTERVAL_MS),
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

// --- Authorization-code connections (Anthropic) ---------------------------

/** Same targets as device authorization: create a named slot, or reconnect one. */
export const startProviderAuthorizationCodeRequestSchema =
  startProviderDeviceAuthorizationRequestSchema;
export type StartProviderAuthorizationCodeRequest = StartProviderDeviceAuthorizationRequest;

export const startProviderAuthorizationCodeResponseSchema = z.strictObject({
  transactionId: providerDeviceAuthorizationIdSchema,
  provider: subscriptionProviderIdSchema,
  operation: z.enum(["create", "reconnect"]),
  /** Where the user grants access; the provider then shows a code to paste back. */
  authorizationUrl: z.url(),
  expiresAt: z.number().int().positive(),
  expiresInMs: z.number().int().positive(),
});
export type StartProviderAuthorizationCodeResponse = z.infer<
  typeof startProviderAuthorizationCodeResponseSchema
>;

/** The code the provider displayed, exactly as the user pasted it (`code` or `code#state`). */
export const completeProviderAuthorizationCodeRequestSchema = z.strictObject({
  code: z.string().trim().min(1).max(4096),
});
export type CompleteProviderAuthorizationCodeRequest = z.infer<
  typeof completeProviderAuthorizationCodeRequestSchema
>;

export const providerAuthorizationCodeStatusResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    expiresAt: z.number().int().positive(),
  }),
  z.strictObject({
    status: z.literal("connected"),
    account: modelProviderAccountSchema,
    reconnectedExisting: z.boolean(),
    completedAt: z.number().int().positive(),
  }),
  terminalProviderDeviceAuthorizationErrorSchema,
]);
export type ProviderAuthorizationCodeStatusResponse = z.infer<
  typeof providerAuthorizationCodeStatusResponseSchema
>;
