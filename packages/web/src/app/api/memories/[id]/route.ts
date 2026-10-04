import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PATCH } = settingsProxy(
  ({ id }: { id: string }) => `/memories/${encodeURIComponent(id)}`,
  "memory"
);
