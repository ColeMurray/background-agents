import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy(() => "/model-preferences", "model preferences");
