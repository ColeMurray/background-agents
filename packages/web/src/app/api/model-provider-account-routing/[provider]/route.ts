import {
  providerAccountSettingsProxy,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";
export const { PUT } = providerAccountSettingsProxy<{ provider: string }>(
  ({ provider }) => `/model-provider-account-routing/${encodeURIComponent(provider)}`,
  "provider account routing",
  ({ provider }) => validSubscriptionProvider(provider)
);
