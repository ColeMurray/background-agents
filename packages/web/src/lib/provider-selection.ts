import type {
  ModelProviderSelections,
  ProviderAuthSelection,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

export type ProviderSelectionDrafts = ModelProviderSelections;
export const EMPTY_PROVIDER_SELECTIONS: ProviderSelectionDrafts = {};

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
