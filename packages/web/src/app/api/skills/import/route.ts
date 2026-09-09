import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/skills/import", "import skill");
