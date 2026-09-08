import { settingsProxy } from "@/lib/settings-proxy";

export const { PATCH, DELETE } = settingsProxy<{ id: string }>(
  ({ id }) => `/skill-profiles/${encodeURIComponent(id)}`,
  "skill profile"
);
