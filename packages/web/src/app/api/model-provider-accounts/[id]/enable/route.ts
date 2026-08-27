import { providerAccountSettingsProxy, validProviderAccountId } from "@/lib/provider-account-proxy";

type Params = { id: string };
const { POST } = providerAccountSettingsProxy<Params>(
  ({ id }) => `/model-provider-accounts/${encodeURIComponent(id)}/enable`,
  "provider account enable",
  ({ id }) => validProviderAccountId(id)
);

export { POST };
