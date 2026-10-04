import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PATCH } = settingsProxy(
  ({ id }: { id: string }) => `/teams/${encodeURIComponent(id)}`,
  "team"
);
