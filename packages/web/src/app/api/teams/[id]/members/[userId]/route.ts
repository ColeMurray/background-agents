import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy(
  ({ id, userId }: { id: string; userId: string }) =>
    `/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
  "team member"
);
