import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/skills/import/preview", "preview skill import");
