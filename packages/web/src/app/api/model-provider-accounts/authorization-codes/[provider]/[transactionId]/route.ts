import {
  providerAccountSettingsProxy,
  validProviderDeviceAuthorizationId,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";

type Params = { provider: string; transactionId: string };
const { GET, DELETE } = providerAccountSettingsProxy<Params>(
  ({ provider, transactionId }) =>
    `/model-provider-accounts/${encodeURIComponent(provider)}/authorization-codes/${encodeURIComponent(transactionId)}`,
  "provider authorization code",
  ({ provider, transactionId }) =>
    validSubscriptionProvider(provider) && validProviderDeviceAuthorizationId(transactionId)
);

export { GET, DELETE };
