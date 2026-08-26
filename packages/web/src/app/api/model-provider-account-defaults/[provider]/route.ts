import {
  providerAccountSettingsProxy,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";

type Params = { provider: string };
const { PUT, DELETE } = providerAccountSettingsProxy<Params>(
  ({ provider }) => `/model-provider-account-defaults/${encodeURIComponent(provider)}`,
  "provider account default",
  ({ provider }) => validSubscriptionProvider(provider)
);

export { DELETE, PUT };
