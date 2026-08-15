import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, POST } = settingsProxy(() => "/skills", "skills");
