import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SessionAction } from "@open-inspect/shared";

export type TeamsEnforcementMode = "off" | "shadow" | "on";

export function parseTeamsEnforcementMode(value: string | undefined): TeamsEnforcementMode {
  if (value === undefined || value === "") return "shadow";
  if (value === "off" || value === "shadow" || value === "on") return value;
  throw new Error(`Invalid TEAMS_ENFORCEMENT: ${value}`);
}

export function legacyPermissionForAction(action: SessionAction): PermissionId {
  switch (action) {
    case "read":
      return "sessions.read";
    case "collaborate":
      return "sessions.collaborate";
    case "delete":
      return "sessions.delete";
    case "sandbox":
      return "sessions.sandbox_access";
    case "lifecycle":
    case "move":
    case "changeVisibility":
    case "manageCollaborators":
      return "sessions.lifecycle";
  }
}
