import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SessionAccessRow, SessionAction } from "@open-inspect/shared";

export type TeamsEnforcementMode = "off" | "shadow" | "on";

export function parseTeamsEnforcementMode(value: string | undefined): TeamsEnforcementMode {
  if (value === undefined || value === "") return "shadow";
  if (value === "off" || value === "shadow" || value === "on") return value;
  throw new Error(`Invalid TEAMS_ENFORCEMENT: ${value}`);
}

/** Private access and team-owned actions are never gated by the rollout mode. */
export function resolverDecides(
  mode: TeamsEnforcementMode,
  row: Pick<SessionAccessRow, "ownerTeamId" | "visibility">,
  action: SessionAction
): boolean {
  return (
    mode === "on" || row.visibility === "private" || (row.ownerTeamId !== null && action !== "read")
  );
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
    case "changeVisibility":
    case "manageCollaborators":
      return "sessions.lifecycle";
  }
}
