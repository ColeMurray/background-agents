import { integrationSettingsProxy } from "@/lib/integration-settings-proxy";

export const { GET, PUT, DELETE } = integrationSettingsProxy<{ id: string }>(
  ({ id }) => `/integration-settings/${encodeURIComponent(id)}`,
  "integration settings"
);
