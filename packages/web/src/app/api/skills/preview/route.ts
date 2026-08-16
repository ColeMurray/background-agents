import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/skills/preview", "preview skill");
