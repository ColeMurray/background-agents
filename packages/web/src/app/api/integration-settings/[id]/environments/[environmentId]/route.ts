import { integrationSettingsProxy } from "@/lib/integration-settings-proxy";

export const { GET, PUT, DELETE } = integrationSettingsProxy<{
  id: string;
  environmentId: string;
}>(
  ({ id, environmentId }) =>
    `/integration-settings/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}`,
  "environment integration settings"
);
