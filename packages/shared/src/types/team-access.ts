import type { Team, TeamRole } from "./teams";

export interface TeamCapabilities {
  canJoin: boolean;
  canLeave: boolean;
  canEditMetadata: boolean;
  canManageMembers: boolean;
  canManageRepositories: boolean;
  canManageBindings: boolean;
  canManageAutomations: boolean;
  canManageSecrets: boolean;
  canArchive: boolean;
}

export function resolveTeamAccess(
  viewer: { userId: string; roleKey: string | null; memberships: ReadonlyMap<string, TeamRole> },
  team: Team & { leadCount: number }
): TeamCapabilities {
  const role = viewer.memberships.get(team.id);
  const manages =
    viewer.roleKey === "owner" || viewer.roleKey === "administrator" || role === "lead";
  return {
    canJoin: role === undefined && team.joinPolicy === "open" && team.archivedAt === null,
    canLeave: role !== undefined && (role !== "lead" || team.leadCount > 1),
    canEditMetadata: manages,
    canManageMembers: manages,
    canManageRepositories: manages,
    canManageBindings: manages,
    canManageAutomations: manages,
    canManageSecrets: manages,
    canArchive: manages,
  };
}
