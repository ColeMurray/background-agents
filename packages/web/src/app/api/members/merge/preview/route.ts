import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/members/merge/preview", "member merge", {
  POST: "preview member merge",
});
