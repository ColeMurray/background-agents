import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/roles/${encodeURIComponent(id)}`,
  "role"
);
