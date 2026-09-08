import { providerAccountSettingsProxy, validProviderAccountId } from "@/lib/provider-account-proxy";

type Params = { id: string };
const { GET, PATCH, DELETE } = providerAccountSettingsProxy<Params>(
  ({ id }) => `/model-provider-accounts/${encodeURIComponent(id)}`,
  "provider account",
  ({ id }) => validProviderAccountId(id)
);

export { DELETE, GET, PATCH };
