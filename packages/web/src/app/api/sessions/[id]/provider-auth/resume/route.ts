import { settingsProxy } from "@/lib/settings-proxy";
export const { POST } = settingsProxy<{ id: string }>(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/provider-auth/resume`,
  "session provider recovery"
);
