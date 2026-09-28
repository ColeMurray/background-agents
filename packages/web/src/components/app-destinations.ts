import {
  AutomationsIcon,
  DataControlsIcon,
  SessionsIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { SESSIONS_PATH } from "@/lib/session-discovery";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { ComponentType } from "react";

export interface AppDestination {
  label: string;
  description: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  requiredPermission?: PermissionId;
}

export const SETTINGS_DESTINATION = {
  label: "Settings",
  description: "Configure Open Inspect",
  href: "/settings",
  icon: SettingsIcon,
} as const satisfies AppDestination;

const SESSIONS_DESTINATION = {
  label: "Sessions",
  description: "Find past and current work across full history",
  href: SESSIONS_PATH,
  icon: SessionsIcon,
  requiredPermission: "sessions.read",
} as const satisfies AppDestination;

export const PRIMARY_APP_DESTINATIONS = [
  SESSIONS_DESTINATION,
  {
    label: "Automations",
    description: "Manage scheduled and event-triggered work",
    href: "/automations",
    icon: AutomationsIcon,
    requiredPermission: "automations.read",
  },
  {
    label: "Analytics",
    description: "View usage across sessions, repositories, and users",
    href: "/analytics",
    icon: DataControlsIcon,
    requiredPermission: "analytics.read",
  },
] as const satisfies readonly AppDestination[];

export const APP_DESTINATIONS = [SETTINGS_DESTINATION, ...PRIMARY_APP_DESTINATIONS] as const;
