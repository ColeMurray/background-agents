import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT, DELETE } = settingsProxy<{
  id: string;
  owner: string;
  name: string;
}>(
  ({ id, owner, name }) =>
    `/integration-settings/${encodeURIComponent(id)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  "repo integration settings"
);
