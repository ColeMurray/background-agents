import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy<{ id: string; userId: string }>(
  ({ id, userId }) =>
    `/sessions/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(userId)}`,
  "session collaborators"
);
