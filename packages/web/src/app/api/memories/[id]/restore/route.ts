import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ id }: { id: string }) => `/memories/${encodeURIComponent(id)}/restore`,
  "memories"
);
