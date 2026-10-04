import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ id }: { id: string }) => `/teams/${encodeURIComponent(id)}/join`,
  "team membership"
);
