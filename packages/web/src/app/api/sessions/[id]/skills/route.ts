import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/skills`,
  "session skills",
  ["GET"]
);
