import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy(
  ({ id, channelId }: { id: string; channelId: string }) =>
    `/teams/${encodeURIComponent(id)}/channel-bindings/slack/${encodeURIComponent(channelId)}`,
  "team channel binding"
);
