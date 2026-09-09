import {
  subscriptionProviderIdSchema,
  type ProviderAuthMode,
  type SessionModelProviderAuth,
  type SessionProviderAuthMode,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

export type ModelProviderId = SubscriptionProviderId;
export type { ProviderAuthMode };

export type SessionModelProviderAuthInput = SessionModelProviderAuth & {
  inheritedFromSessionId?: string | null;
};

export function assertModelProviderId(provider: string): asserts provider is ModelProviderId {
  if (!subscriptionProviderIdSchema.safeParse(provider).success) {
    throw new Error(`Unsupported model provider: ${provider}`);
  }
}

export function assertProviderAuthSelection(
  provider: string,
  authMode: SessionProviderAuthMode,
  providerAccountId: string | null | undefined
): asserts provider is ModelProviderId {
  assertModelProviderId(provider);
  if (
    (authMode === "provider_account" && !providerAccountId) ||
    (authMode !== "provider_account" && providerAccountId != null)
  ) {
    throw new Error(`Invalid ${provider} provider auth selection`);
  }
}
