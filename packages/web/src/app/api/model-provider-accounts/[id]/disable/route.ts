import { providerAccountSettingsProxy, validProviderAccountId } from "@/lib/provider-account-proxy";

type Params = { id: string };
const { POST } = providerAccountSettingsProxy<Params>(
  ({ id }) => `/model-provider-accounts/${encodeURIComponent(id)}/disable`,
  "provider account disable",
  ({ id }) => validProviderAccountId(id)
);

export { POST };
