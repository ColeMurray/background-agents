import {
  providerAccountSettingsProxy,
  validProviderDeviceAuthorizationId,
  validProviderForConnectionMethod,
} from "@/lib/provider-account-proxy";

type Params = { provider: string; transactionId: string };
const { GET, DELETE } = providerAccountSettingsProxy<Params>(
  ({ provider, transactionId }) =>
    `/model-provider-accounts/${encodeURIComponent(provider)}/authorization-codes/${encodeURIComponent(transactionId)}`,
  "provider authorization code",
  ({ provider, transactionId }) =>
    validProviderForConnectionMethod(provider, "authorization_code") &&
    validProviderDeviceAuthorizationId(transactionId)
);

export { GET, DELETE };
