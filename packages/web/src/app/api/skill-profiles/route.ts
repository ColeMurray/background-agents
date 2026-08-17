import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, POST } = settingsProxy(() => "/skill-profiles", "skill profiles");
