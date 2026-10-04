import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/memories/${encodeURIComponent(id)}/revisions`,
  "memory revisions"
);
