import {
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderSelections,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
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

function legacy(provider: SubscriptionProviderId): SessionModelProviderAuthInput {
  return { provider, authMode: "legacy_scoped_oauth", selectionSource: "legacy_fallback" };
}

export interface ProviderAccountResolutionInput {
  explicit?: ModelProviderSelections;
  unattended: boolean;
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
  if (!providerDefault) return legacy(provider);
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
