import { settingsProxy } from "@/lib/settings-proxy";

export const { DELETE } = settingsProxy(
  ({ id }: { id: string }) => `/settings/personal-access-tokens/${encodeURIComponent(id)}`,
  "personal access token",
  { DELETE: "revoke personal access token" }
);
