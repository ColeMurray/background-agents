import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT } = settingsProxy<{ id: string }>(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/visibility`,
  "session visibility"
);
