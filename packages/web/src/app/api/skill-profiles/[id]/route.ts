import { settingsProxy } from "@/lib/settings-proxy";

export const { PATCH, DELETE } = settingsProxy(
  ({ id }) => `/skill-profiles/${encodeURIComponent(id)}`,
  "skill profile",
  ["PATCH", "DELETE"]
);
