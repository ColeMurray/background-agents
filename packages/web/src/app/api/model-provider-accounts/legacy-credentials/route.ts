import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  () => "/model-provider-accounts/legacy-credentials",
  "legacy provider credentials"
);
