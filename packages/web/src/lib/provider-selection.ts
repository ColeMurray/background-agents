import {
  modelProviderSelectionsSchema,
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderAccount,
  type ModelProviderAccountDefault,
  type ModelProviderSelections,
  type ProviderAuthSelection,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

export type ProviderSelectionDrafts = ModelProviderSelections;
export const EMPTY_PROVIDER_SELECTIONS: ProviderSelectionDrafts = {};

export type InteractiveProviderRoutingIdentity = Record<
  SubscriptionProviderId,
  | { mode: "api_key" | "legacy_scoped_oauth" }
  | {
      mode: "provider_account";
      accountId: string;
      status: ModelProviderAccount["status"] | "unavailable";
      archivedAt: number | null;
    }
>;

export function buildInteractiveProviderRoutingIdentity(
  selections: ModelProviderSelections,
  defaults: ModelProviderAccountDefault[],
  accounts: ModelProviderAccount[]
): InteractiveProviderRoutingIdentity {
  return Object.fromEntries(
    SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
      const explicit = selections[provider];
      if (explicit?.mode === "api_key") return [provider, { mode: "api_key" }];

      const accountId =
        explicit?.mode === "provider_account"
          ? explicit.accountId
          : defaults.find((providerDefault) => providerDefault.provider === provider)
              ?.providerAccountId;
      if (!accountId) return [provider, { mode: "legacy_scoped_oauth" }];

      const account = accounts.find(
        (candidate) => candidate.id === accountId && candidate.provider === provider
      );
      return [
        provider,
        {
          mode: "provider_account",
          accountId,
          status: account?.status ?? "unavailable",
          archivedAt: account?.archivedAt ?? null,
        },
      ];
    })
  ) as InteractiveProviderRoutingIdentity;
}

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

export function reconcileProviderSelections(
  selections: ModelProviderSelections,
  accounts: ModelProviderAccount[]
): ModelProviderSelections {
  let changed = false;
  const next: ModelProviderSelections = {};

  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    const selection = selections[provider];
    if (!selection) continue;

    const available =
      selection.mode === "api_key" ||
      accounts.some(
        (account) =>
          account.id === selection.accountId &&
          account.provider === provider &&
          account.status === "active" &&
          !account.archivedAt
      );
    if (available) next[provider] = selection;
    else changed = true;
  }

  return changed ? next : selections;
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
