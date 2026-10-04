import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/me/teams", "my teams");
