import { AutomationsIcon, DataControlsIcon, SettingsIcon } from "@/components/ui/icons";

export const SETTINGS_DESTINATION = {
  label: "Settings",
  description: "Configure Open Inspect",
  href: "/settings",
  icon: SettingsIcon,
} as const;

export const PRIMARY_APP_DESTINATIONS = [
  {
    label: "Automations",
    description: "Manage scheduled and event-triggered work",
    href: "/automations",
    icon: AutomationsIcon,
  },
  {
    label: "Analytics",
    description: "View usage across sessions, repositories, and users",
    href: "/analytics",
    icon: DataControlsIcon,
  },
] as const;

export const APP_DESTINATIONS = [SETTINGS_DESTINATION, ...PRIMARY_APP_DESTINATIONS] as const;
