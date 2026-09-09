import {
  providerAccountSettingsProxy,
  validProviderDeviceAuthorizationId,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";

type Params = { provider: string; transactionId: string };
const { POST } = providerAccountSettingsProxy<Params>(
  ({ provider, transactionId }) =>
    `/model-provider-accounts/${encodeURIComponent(provider)}/authorization-codes/${encodeURIComponent(transactionId)}/complete`,
  "provider authorization code completion",
  ({ provider, transactionId }) =>
    validSubscriptionProvider(provider) && validProviderDeviceAuthorizationId(transactionId)
);

export { POST };
