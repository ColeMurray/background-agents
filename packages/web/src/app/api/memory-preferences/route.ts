import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy(() => "/memory-preferences", "memories");
