import { settingsProxy } from "@/lib/settings-proxy";
export const { GET } = settingsProxy(
  () => "/model-provider-account-routing",
  "provider account routing"
);
