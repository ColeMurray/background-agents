import {
  providerAccountSettingsProxy,
  validProviderDeviceAuthorizationId,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";

type Params = { provider: string; transactionId: string };
const { POST } = providerAccountSettingsProxy<Params>(
  ({ provider, transactionId }) =>
    `/model-provider-accounts/${encodeURIComponent(provider)}/device-authorizations/${encodeURIComponent(transactionId)}/poll`,
  "provider device authorization status",
  ({ provider, transactionId }) =>
    validSubscriptionProvider(provider) && validProviderDeviceAuthorizationId(transactionId)
);

export { POST };
