import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT } = settingsProxy(
  ({ id }) => `/skills/${encodeURIComponent(id)}/content`,
  "skill content",
  ["PUT"]
);
