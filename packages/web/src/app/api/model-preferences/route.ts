import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PATCH, PUT } = settingsProxy(() => "/model-preferences", "model preferences");
