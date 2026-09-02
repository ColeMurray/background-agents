import useSWR from "swr";
import { z, type ZodType } from "zod";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  modelProviderAccountDefaultsResponseSchema,
  modelProviderAccountDefaultResponseSchema,
  modelProviderAccountResponseSchema,
  modelProviderAccountsResponseSchema,
  providerDeviceAuthorizationIdSchema,
  providerDeviceAuthorizationStatusResponseSchema,
  createModelProviderAccountResponseSchema,
  legacyProviderCredentialsResponseSchema,
  SUBSCRIPTION_PROVIDER_DISPLAY_METADATA,
  SUBSCRIPTION_PROVIDER_IDS,
  subscriptionProviderIdSchema,
  startProviderDeviceAuthorizationRequestSchema,
  startProviderDeviceAuthorizationResponseSchema,
  type ConnectModelProviderAccountRequest,
  type ModelProviderAccount,
  type ModelProviderAccountDefault,
  type ReconnectModelProviderAccountRequest,
  type StartProviderDeviceAuthorizationRequest,
  type StartProviderDeviceAuthorizationResponse,
  type LegacyProviderCredentialsResponse,
  type LegacyProviderKeyLocation,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

const ACCOUNTS_KEY = "/api/model-provider-accounts";
const DEFAULTS_KEY = "/api/model-provider-account-defaults";
const LEGACY_CREDENTIALS_KEY = "/api/model-provider-accounts/legacy-credentials";
const providerErrorResponseSchema = z.object({
  error: z.string(),
  retryable: z.boolean().optional(),
});

export type { LegacyProviderKeyLocation };

export class ProviderResourceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable?: boolean
  ) {
    super(message);
    this.name = "ProviderResourceError";
  }
}

async function requestProviderResponse(
  path: BrowserApiPath,
  init?: { method?: string; body?: unknown; signal?: AbortSignal }
): Promise<Response> {
  const response = await browserApiFetch(path, {
    method: init?.method,
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
  });
  if (!response.ok) {
    const parsed = providerErrorResponseSchema.safeParse(await response.json().catch(() => null));
    throw new ProviderResourceError(
      (parsed.success && parsed.data.error) || "Provider account request failed",
      response.status,
      parsed.success ? parsed.data.retryable : undefined
    );
  }
  return response;
}

async function requestProviderResource<T>(
  path: BrowserApiPath,
  schema: ZodType<T>,
  init?: { method?: string; body?: unknown; signal?: AbortSignal }
): Promise<T> {
  const response = await requestProviderResponse(path, init);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Invalid provider account response");
  return parsed.data;
}

async function requestProviderResourceWithoutContent(
  path: BrowserApiPath,
  init: { method: string; body?: unknown }
): Promise<void> {
  const response = await requestProviderResponse(path, init);
  if (response.status !== 204) throw new Error("Invalid provider account response");
}

export function useProviderAccounts() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canRead = hasPermission("provider_accounts.read");
  const accounts = useSWR(canRead ? ACCOUNTS_KEY : null, async (path) => {
    return (await requestProviderResource(path, modelProviderAccountsResponseSchema)).accounts;
  });
  const defaults = useSWR(canRead ? DEFAULTS_KEY : null, async (path) => {
    return (await requestProviderResource(path, modelProviderAccountDefaultsResponseSchema))
      .defaults;
  });

  return {
    providers: SUBSCRIPTION_PROVIDER_IDS.map((provider) => ({
      provider,
      ...SUBSCRIPTION_PROVIDER_DISPLAY_METADATA[provider],
    })),
    accounts: (accounts.data ?? []) as ModelProviderAccount[],
    defaults: (defaults.data ?? []) as ModelProviderAccountDefault[],
    loading: accounts.isLoading || defaults.isLoading,
    error: accounts.error ?? defaults.error,
    refresh: async () => Promise.all([accounts.mutate(), defaults.mutate()]),
  };
}

export function useLegacyProviderCredentials() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canRead = hasPermission("provider_accounts.read");
  const result = useSWR<LegacyProviderCredentialsResponse>(
    canRead ? LEGACY_CREDENTIALS_KEY : null,
    async (path: BrowserApiPath) => {
      return requestProviderResource(path, legacyProviderCredentialsResponseSchema);
    }
  );
  return {
    legacyKeys: result.data?.legacyKeys ?? [],
    loading: result.isLoading,
    error: result.error,
    refresh: result.mutate,
  };
}

export async function connectProviderAccount(input: ConnectModelProviderAccountRequest) {
  return (
    await requestProviderResource(ACCOUNTS_KEY, createModelProviderAccountResponseSchema, {
      method: "POST",
      body: input,
    })
  ).account;
}

export async function startProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  input: StartProviderDeviceAuthorizationRequest
): Promise<StartProviderDeviceAuthorizationResponse> {
  const parsedProvider = subscriptionProviderIdSchema.parse(provider);
  const request = startProviderDeviceAuthorizationRequestSchema.parse(input);
  return requestProviderResource(
    `${ACCOUNTS_KEY}/device-authorizations/${parsedProvider}`,
    startProviderDeviceAuthorizationResponseSchema,
    { method: "POST", body: request }
  );
}

export async function pollProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  transactionId: string,
  signal?: AbortSignal
) {
  const parsedProvider = subscriptionProviderIdSchema.parse(provider);
  const id = providerDeviceAuthorizationIdSchema.parse(transactionId);
  return requestProviderResource(
    `${ACCOUNTS_KEY}/device-authorizations/${parsedProvider}/${id}/poll`,
    providerDeviceAuthorizationStatusResponseSchema,
    { method: "POST", body: {}, signal }
  );
}

export async function cancelProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  transactionId: string
) {
  const parsedProvider = subscriptionProviderIdSchema.parse(provider);
  const id = providerDeviceAuthorizationIdSchema.parse(transactionId);
  await requestProviderResourceWithoutContent(
    `${ACCOUNTS_KEY}/device-authorizations/${parsedProvider}/${id}`,
    { method: "DELETE" }
  );
}

export async function renameProviderAccount(id: string, displayName: string) {
  return (
    await requestProviderResource(`${ACCOUNTS_KEY}/${id}`, modelProviderAccountResponseSchema, {
      method: "PATCH",
      body: { displayName },
    })
  ).account;
}

export async function reconnectProviderAccount(
  id: string,
  input: ReconnectModelProviderAccountRequest
) {
  return (
    await requestProviderResource(
      `${ACCOUNTS_KEY}/${id}/reconnect`,
      modelProviderAccountResponseSchema,
      { method: "POST", body: input }
    )
  ).account;
}

export async function runProviderAccountAction(
  id: string,
  action: "verify" | "disable" | "enable"
) {
  return (
    await requestProviderResource(
      `${ACCOUNTS_KEY}/${id}/${action}`,
      modelProviderAccountResponseSchema,
      { method: "POST", body: {} }
    )
  ).account;
}

export async function archiveProviderAccount(id: string) {
  return requestProviderResourceWithoutContent(`${ACCOUNTS_KEY}/${id}`, { method: "DELETE" });
}

export async function setProviderAccountDefault(
  provider: SubscriptionProviderId,
  providerAccountId: string,
  unattendedMode: "provider_account" | "api_key"
) {
  return (
    await requestProviderResource(
      `${DEFAULTS_KEY}/${provider}`,
      modelProviderAccountDefaultResponseSchema,
      {
        method: "PUT",
        body: { providerAccountId, unattendedMode },
      }
    )
  ).default;
}
