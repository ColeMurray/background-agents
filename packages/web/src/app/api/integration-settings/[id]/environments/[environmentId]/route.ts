import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT, DELETE } = settingsProxy<{
  id: string;
  environmentId: string;
}>(
  ({ id, environmentId }) =>
    `/integration-settings/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}`,
  "environment integration settings"
);
