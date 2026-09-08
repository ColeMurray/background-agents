import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy<Record<string, never>>(
  () => "/scm-settings/repos",
  "SCM repo settings"
);
