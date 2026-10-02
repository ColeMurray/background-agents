import { settingsProxy } from "@/lib/settings-proxy";
export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/sessions/${encodeURIComponent(id)}/project-snapshot`,
  "session project"
);
