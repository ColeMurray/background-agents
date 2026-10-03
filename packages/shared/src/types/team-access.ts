import { isWorkspaceAdmin, type PermissionId } from "../rbac";
import type { Team, TeamRole } from "./teams";

export interface TeamCapabilities {
  canViewWork: boolean;
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
  const canViewWork = !viewer.suspended && (isWorkspaceAdmin(viewer.roleKey) || role !== undefined);
  return {
    canViewWork,
    canReadAutomations: canViewWork && viewer.permissions.includes("automations.read"),
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
