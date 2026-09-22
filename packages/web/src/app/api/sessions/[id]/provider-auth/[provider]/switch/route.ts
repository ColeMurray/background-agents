import {
  providerAccountSettingsProxy,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";
export const { POST } = providerAccountSettingsProxy<{ id: string; provider: string }>(
  ({ id, provider }) =>
    `/sessions/${encodeURIComponent(id)}/provider-auth/${encodeURIComponent(provider)}/switch`,
  "session provider switch",
  ({ provider }) => validSubscriptionProvider(provider)
);
