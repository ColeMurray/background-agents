import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy<{ owner: string; name: string }>(
  ({ owner, name }) =>
    `/scm-settings/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  "SCM repo settings"
);
