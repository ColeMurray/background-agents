import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  () => "/personal-access-tokens/policy",
  "personal access token policy"
);
