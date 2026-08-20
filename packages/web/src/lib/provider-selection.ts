import {
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderSelections,
  type ProviderAuthSelection,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

export type ProviderSelectionDrafts = ModelProviderSelections;

export function setProviderSelection(
  selections: ProviderSelectionDrafts,
  provider: SubscriptionProviderId,
  selection: ProviderAuthSelection | undefined
): ProviderSelectionDrafts {
  if (selection) return { ...selections, [provider]: selection };
  const next = { ...selections };
  delete next[provider];
  return next;
}

export function providerSelectionsKey(selections: ProviderSelectionDrafts): string {
  return SUBSCRIPTION_PROVIDER_IDS.flatMap((provider) => {
    const selection = selections[provider];
    if (!selection) return [];
    return [
      selection.mode === "api_key"
        ? `${provider}:api_key`
        : `${provider}:provider_account:${selection.accountId}`,
    ];
  }).join("|");
}
