import { providerAccountSettingsProxy, validProviderAccountId } from "@/lib/provider-account-proxy";

type Params = { id: string };
export const { GET } = providerAccountSettingsProxy<Params>(
  ({ id }) => `/model-provider-accounts/${encodeURIComponent(id)}/usage`,
  "provider account usage",
  ({ id }) => validProviderAccountId(id)
);
