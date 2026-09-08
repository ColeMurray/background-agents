import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy<{ id: string }>(
  ({ id }) => `/skills/${encodeURIComponent(id)}/reimport/preview`,
  "preview skill re-import"
);
