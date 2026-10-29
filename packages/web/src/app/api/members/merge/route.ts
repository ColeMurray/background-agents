import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/members/merge", "members", {
  POST: "merge members",
});
