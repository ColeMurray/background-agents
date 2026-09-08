import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT, DELETE } = settingsProxy<{ id: string }>(
  ({ id }) => `/integration-settings/${encodeURIComponent(id)}`,
  "integration settings"
);
