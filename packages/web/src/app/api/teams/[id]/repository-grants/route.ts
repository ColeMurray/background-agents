import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy(
  ({ id }: { id: string }) => `/teams/${encodeURIComponent(id)}/repository-grants`,
  "team repository grants"
);
