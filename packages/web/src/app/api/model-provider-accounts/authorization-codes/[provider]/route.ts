import {
  providerAccountSettingsProxy,
  validProviderForConnectionMethod,
} from "@/lib/provider-account-proxy";

type Params = { provider: string };
const { POST } = providerAccountSettingsProxy<Params>(
  ({ provider }) => `/model-provider-accounts/${encodeURIComponent(provider)}/authorization-codes`,
  "provider authorization code",
  ({ provider }) => validProviderForConnectionMethod(provider, "authorization_code")
);

export { POST };
