import { integrationSettingsProxy } from "@/lib/integration-settings-proxy";

export const { GET, PUT, DELETE } = integrationSettingsProxy<{
  id: string;
  owner: string;
  name: string;
}>(
  ({ id, owner, name }) =>
    `/integration-settings/${encodeURIComponent(id)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  "repo integration settings"
);
