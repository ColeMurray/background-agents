import { settingsProxy } from "@/lib/settings-proxy";
export const { GET } = settingsProxy<{ id: string }>(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/provider-auth`,
  "session provider account"
);
