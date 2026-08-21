import {
  modelProviderSelectionsSchema,
  type ModelProviderSelections,
  type ProviderAuthSelection,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

export type ProviderSelectionDrafts = ModelProviderSelections;

export function parseStoredProviderSelections(
  value: string | null
): ModelProviderSelections | null {
  if (!value) return null;

  try {
    const parsed = modelProviderSelectionsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
