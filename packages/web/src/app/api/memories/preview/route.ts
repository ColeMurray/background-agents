import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/memories/preview", "memories");
