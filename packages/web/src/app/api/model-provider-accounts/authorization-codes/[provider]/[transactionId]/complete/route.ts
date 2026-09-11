import {
  providerAccountSettingsProxy,
  validProviderDeviceAuthorizationId,
  validProviderForConnectionMethod,
} from "@/lib/provider-account-proxy";

type Params = { provider: string; transactionId: string };
const { POST } = providerAccountSettingsProxy<Params>(
  ({ provider, transactionId }) =>
    `/model-provider-accounts/${encodeURIComponent(provider)}/authorization-codes/${encodeURIComponent(transactionId)}/complete`,
  "provider authorization code completion",
  ({ provider, transactionId }) =>
    validProviderForConnectionMethod(provider, "authorization_code") &&
    validProviderDeviceAuthorizationId(transactionId)
);

export { POST };
