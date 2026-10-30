import {
  providerAccountSettingsProxy,
  validSubscriptionProvider,
} from "@/lib/provider-account-proxy";

type Params = { provider: string };
const { PUT } = providerAccountSettingsProxy<Params>(
  ({ provider }) => `/model-provider-account-routing/${encodeURIComponent(provider)}`,
  "provider account routing",
  ({ provider }) => validSubscriptionProvider(provider)
);

export { PUT };
