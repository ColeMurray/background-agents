import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PATCH, PUT, DELETE } = settingsProxy<{ id: string }>(
  ({ id }) => `/integration-settings/${encodeURIComponent(id)}`,
  "integration settings"
);
