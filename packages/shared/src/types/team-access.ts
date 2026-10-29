import { isWorkspaceAdmin, type PermissionId } from "../rbac";
import type { Team, TeamRole } from "./teams";

export interface TeamCapabilities {
  canReadTeamSessions: boolean;
  canReadTeamRepositories: boolean;
  canReadTeamEnvironments: boolean;
  canReadAutomations: boolean;
  canJoin: boolean;
  canLeave: boolean;
  canEditMetadata: boolean;
  canManageMembers: boolean;
  canManageRepositories: boolean;
  canManageBindings: boolean;
  canManageAutomations: boolean;
  canManageEnvironments: boolean;
  canManageSecrets: boolean;
  canArchive: boolean;
}

export function resolveTeamAccess(
  viewer: {
    userId: string;
    roleKey: string | null;
    suspended: boolean;
    permissions: readonly PermissionId[];
    memberships: ReadonlyMap<string, TeamRole>;
  },
  team: Team & { leadCount: number }
): TeamCapabilities {
  const role = viewer.memberships.get(team.id);
  const manages = isWorkspaceAdmin(viewer.roleKey) || role === "lead";
  const eligible = !viewer.suspended && (isWorkspaceAdmin(viewer.roleKey) || role !== undefined);
  return {
    canReadTeamSessions: eligible && viewer.permissions.includes("sessions.read"),
    canReadTeamRepositories: eligible,
    canReadTeamEnvironments: eligible && viewer.permissions.includes("environments.read"),
    canReadAutomations: eligible && viewer.permissions.includes("automations.read"),
    canJoin: role === undefined && team.joinPolicy === "open" && team.archivedAt === null,
    canLeave: role !== undefined && (role !== "lead" || team.leadCount > 1),
    canEditMetadata: manages,
    canManageMembers: manages,
    canManageRepositories: manages,
    canManageBindings: manages,
    canManageAutomations: manages,
    canManageEnvironments: manages,
    canManageSecrets: manages,
    canArchive: manages,
  };
}

/** Workspace-wide session discovery is distinct from the public team directory. */
export function resolveWorkspaceTeamAccess(viewer: { roleKey: string | null; suspended: boolean }) {
  return { canListAllTeams: !viewer.suspended && isWorkspaceAdmin(viewer.roleKey) };
}
