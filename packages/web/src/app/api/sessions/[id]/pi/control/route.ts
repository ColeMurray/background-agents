import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ id }: { id: string }) => `/sessions/${encodeURIComponent(id)}/pi/control`,
  "Pi agent control"
);
