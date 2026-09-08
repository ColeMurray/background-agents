import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/skills/resolve-preview", "preview skill resolution");
