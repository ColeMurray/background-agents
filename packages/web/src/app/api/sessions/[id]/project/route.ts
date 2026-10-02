import { settingsProxy } from "@/lib/settings-proxy";
export const { PUT } = settingsProxy(
  ({ id }: { id: string }) => `/sessions/${encodeURIComponent(id)}/project`,
  "session project"
);
