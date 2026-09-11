import {
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderSelections,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { harnessSupportsProviderAuth, type HarnessId } from "@open-inspect/shared/harnesses";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase } from "../db/sql-database";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import {
  ProviderAccountSelectionPolicy,
  type ProviderAccountAdapterLookup,
} from "../model-provider-accounts/selection-policy";

interface ProviderAccountResolutionStores {
  defaults: Pick<ProviderDefaultStore, "get">;
  accounts: Pick<ModelProviderAccountStore, "getById">;
  adapters: ProviderAccountAdapterLookup;
}

/**
 * What a provider resolves to when nothing was selected and no default exists.
 * OpenAI and xAI keep the legacy scoped-OAuth path their plugins understand;
 * Anthropic never had one, so it falls back to the API key (the platform key
 * or a user secret), never to a placeholder.
 */
function noSelectionFallback(provider: SubscriptionProviderId): SessionModelProviderAuthInput {
  if (LEGACY_SCOPED_OAUTH_PROVIDERS.has(provider)) {
    return { provider, authMode: "legacy_scoped_oauth", selectionSource: "legacy_fallback" };
  }
  return apiKey(provider, "api_key_fallback");
}

const LEGACY_SCOPED_OAUTH_PROVIDERS: ReadonlySet<SubscriptionProviderId> = new Set([
  "openai",
  "xai",
]);

export interface ProviderAccountResolutionInput {
  explicit?: ModelProviderSelections;
  unattended: boolean;
  /**
   * The session's harness. An installation default only applies where the
   * harness can select a provider account; otherwise the provider resolves
   * to api_key (selectionSource "harness_fallback") rather than binding an
   * account the harness cannot use.
   */
  harness: HarnessId;
}

function apiKey(
  provider: SubscriptionProviderId,
  selectionSource: string
): SessionModelProviderAuthInput {
  return { provider, authMode: "api_key", selectionSource };
}

async function resolveProvider(
  provider: SubscriptionProviderId,
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores,
  policy: ProviderAccountSelectionPolicy
): Promise<SessionModelProviderAuthInput> {
  const explicit = input.explicit?.[provider];
  if (explicit?.mode === "api_key") return apiKey(provider, "explicit");
  if (explicit?.mode === "provider_account") {
    const account = await policy.validateSelection(provider, explicit.accountId);
    return {
      provider,
      authMode: "provider_account",
      providerAccountId: account.id,
      selectionSource: "explicit",
    };
  }

  const providerDefault = await stores.defaults.get(provider);
  if (!providerDefault) return noSelectionFallback(provider);
  if (!harnessSupportsProviderAuth(input.harness, provider, "provider_account")) {
    return apiKey(provider, "harness_fallback");
  }
  if (input.unattended && providerDefault.unattendedMode === "api_key") {
    return apiKey(provider, "unattended_policy");
  }

  const account = await policy.validateDefault(provider, providerDefault.providerAccountId);
  return {
    provider,
    authMode: "provider_account",
    providerAccountId: account.id,
    selectionSource: input.unattended ? "unattended_policy" : "installation_default",
  };
}

export async function resolveProviderAccountSelections(
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores
): Promise<SessionModelProviderAuthInput[]> {
  const policy = new ProviderAccountSelectionPolicy(stores.accounts, stores.adapters);
  return Promise.all(
    SUBSCRIPTION_PROVIDER_IDS.map((provider) => resolveProvider(provider, input, stores, policy))
  );
}

export function resolveSessionProviderAuth(
  db: SqlDatabase,
  input: ProviderAccountResolutionInput
): Promise<SessionModelProviderAuthInput[]> {
  return resolveProviderAccountSelections(input, {
    defaults: new ProviderDefaultStore(db),
    accounts: new ModelProviderAccountStore(db),
    adapters: modelProviderAccountAdapterRegistry,
  });
}
