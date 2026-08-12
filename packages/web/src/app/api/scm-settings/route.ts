import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT, DELETE } = settingsProxy<Record<string, never>>(
  () => "/scm-settings",
  "SCM settings"
);
