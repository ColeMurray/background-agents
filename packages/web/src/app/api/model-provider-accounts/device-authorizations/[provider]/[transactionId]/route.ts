import {
  providerAccountSettingsProxy,
  validProviderDeviceAuthorizationId,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";

type Params = { provider: string; transactionId: string };
const { DELETE } = providerAccountSettingsProxy<Params>(
  ({ provider, transactionId }) =>
    `/model-provider-accounts/${encodeURIComponent(provider)}/device-authorizations/${encodeURIComponent(transactionId)}`,
  "provider device authorization",
  ({ provider, transactionId }) =>
    validSubscriptionProvider(provider) && validProviderDeviceAuthorizationId(transactionId)
);

export { DELETE };
