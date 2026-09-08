import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy(() => "/keyboard-shortcuts", "keyboard shortcuts");
