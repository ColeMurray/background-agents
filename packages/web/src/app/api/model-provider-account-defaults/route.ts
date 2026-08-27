import { settingsProxy } from "@/lib/settings-proxy";
export const { GET } = settingsProxy(
  () => "/model-provider-account-defaults",
  "provider account defaults"
);
