import { integrationSettingsProxy } from "@/lib/integration-settings-proxy";

export const { GET, PUT, PATCH, DELETE } = integrationSettingsProxy<{ id: string }>(
  ({ id }) => `/integration-settings/${encodeURIComponent(id)}`,
  "integration settings"
);
