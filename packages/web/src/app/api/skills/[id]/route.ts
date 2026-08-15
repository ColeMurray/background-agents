import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PATCH, PUT, DELETE } = settingsProxy(
  ({ id }) => `/skills/${encodeURIComponent(id)}`,
  "skill",
  ["GET", "PATCH", "PUT", "DELETE"]
);
