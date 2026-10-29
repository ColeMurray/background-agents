import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/teams/${encodeURIComponent(id)}/slack-channels`,
  "team Slack channels"
);
