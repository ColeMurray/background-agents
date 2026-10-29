import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PATCH } = settingsProxy(() => "/settings/teams", "team settings");
