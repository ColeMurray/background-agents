import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy<{ id: string }>(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/collaborator-candidates`,
  "session collaborator candidates"
);
