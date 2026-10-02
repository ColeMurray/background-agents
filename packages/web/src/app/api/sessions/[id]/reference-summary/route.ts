import { settingsProxy } from "@/lib/settings-proxy";
export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/sessions/${encodeURIComponent(id)}/reference-summary`,
  "session project"
);
