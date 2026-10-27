import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/memories/bulk", "memories", {
  POST: "update memories",
});
