import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy<{ id: string }>(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/skills`,
  "session skills"
);
