import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ id }: { id: string }) => `/teams/${encodeURIComponent(id)}/restore`,
  "team restore"
);
