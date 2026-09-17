import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/members", "members");
