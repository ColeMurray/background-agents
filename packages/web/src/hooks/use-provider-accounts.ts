import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  modelProviderAccountDefaultsResponseSchema,
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

async function mutateProviderResource<T>(
  path: BrowserApiPath,
  method: string,
  body?: unknown,
  inspectResponse?: (response: Response) => void
): Promise<T> {
  const response = await browserApiFetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  inspectResponse?.(response);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      retryable?: boolean;
    };
    throw new ProviderResourceError(
      payload.error || "Provider account request failed",
      response.status,
      typeof payload.retryable === "boolean" ? payload.retryable : undefined
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function useProviderAccounts() {
  const { data: session } = useAuthSession();
  const accounts = useSWR(session ? ACCOUNTS_KEY : null, async (path) => {
    const parsed = modelProviderAccountsResponseSchema.safeParse(
      await browserApiFetch(path).then((response) => response.json())
    );
    if (!parsed.success) throw new Error("Invalid provider accounts response");
    return parsed.data.accounts;
  });
  const defaults = useSWR(session ? DEFAULTS_KEY : null, async (path) => {
    const parsed = modelProviderAccountDefaultsResponseSchema.safeParse(
      await browserApiFetch(path).then((response) => response.json())
    );
    if (!parsed.success) throw new Error("Invalid provider account defaults response");
    return parsed.data.defaults;
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
  const { data: session } = useAuthSession();
  const result = useSWR<LegacyProviderCredentialsResponse>(
    session ? LEGACY_CREDENTIALS_KEY : null,
    async (path: BrowserApiPath) => {
      const response = await browserApiFetch(path);
      if (!response.ok) throw new Error("Failed to load legacy provider credentials");
      const parsed = legacyProviderCredentialsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Invalid legacy provider credentials response");
      return parsed.data;
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
  const payload = await mutateProviderResource<unknown>(ACCOUNTS_KEY, "POST", input);
  const parsed = createModelProviderAccountResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid provider account response");
  return parsed.data.account;
}

export async function startProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  input: StartProviderDeviceAuthorizationRequest
): Promise<StartProviderDeviceAuthorizationResponse> {
  const parsedProvider = subscriptionProviderIdSchema.parse(provider);
  const request = startProviderDeviceAuthorizationRequestSchema.parse(input);
  const payload = await mutateProviderResource<unknown>(
    `${ACCOUNTS_KEY}/device-authorizations/${parsedProvider}`,
    "POST",
    request
  );
  const parsed = startProviderDeviceAuthorizationResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid device authorization response");
  return parsed.data;
}

export async function pollProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  transactionId: string
) {
  const parsedProvider = subscriptionProviderIdSchema.parse(provider);
  const id = providerDeviceAuthorizationIdSchema.parse(transactionId);
  const payload = await mutateProviderResource<unknown>(
    `${ACCOUNTS_KEY}/device-authorizations/${parsedProvider}/${id}/poll`,
    "POST",
    {}
  );
  const parsed = providerDeviceAuthorizationStatusResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid device authorization status response");
  return parsed.data;
}

export async function cancelProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  transactionId: string
) {
  const parsedProvider = subscriptionProviderIdSchema.parse(provider);
  const id = providerDeviceAuthorizationIdSchema.parse(transactionId);
  await mutateProviderResource<void>(
    `${ACCOUNTS_KEY}/device-authorizations/${parsedProvider}/${id}`,
    "DELETE"
  );
}

export async function renameProviderAccount(id: string, displayName: string) {
  return mutateProviderResource(`${ACCOUNTS_KEY}/${id}`, "PATCH", { displayName });
}

export async function reconnectProviderAccount(
  id: string,
  input: ReconnectModelProviderAccountRequest
) {
  return mutateProviderResource(`${ACCOUNTS_KEY}/${id}/reconnect`, "POST", input);
}

export async function runProviderAccountAction(
  id: string,
  action: "verify" | "disable" | "enable"
) {
  return mutateProviderResource(`${ACCOUNTS_KEY}/${id}/${action}`, "POST", {});
}

export async function archiveProviderAccount(id: string) {
  return mutateProviderResource(`${ACCOUNTS_KEY}/${id}`, "DELETE");
}

export async function setProviderAccountDefault(
  provider: SubscriptionProviderId,
  providerAccountId: string,
  unattendedMode: "provider_account" | "api_key"
) {
  return mutateProviderResource(`${DEFAULTS_KEY}/${provider}`, "PUT", {
    providerAccountId,
    unattendedMode,
  });
}

export async function clearProviderAccountDefault(provider: SubscriptionProviderId) {
  return mutateProviderResource(`${DEFAULTS_KEY}/${provider}`, "DELETE");
}
