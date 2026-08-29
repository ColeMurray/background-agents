import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT, DELETE } = settingsProxy(
  ({ id }: { id: string }) => `/roles/${encodeURIComponent(id)}`,
  "role"
);
