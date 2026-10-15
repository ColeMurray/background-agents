import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy<{ id: string }>(
  ({ id }) => `/opencode-plugins/${encodeURIComponent(id)}`,
  "OpenCode plugin"
);
