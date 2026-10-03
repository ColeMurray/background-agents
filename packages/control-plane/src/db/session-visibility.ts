import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import type { SessionViewer } from "@open-inspect/shared";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";

export type SessionReadScope = SessionViewer | { kind: "internal"; reason: string };

/** A SQL visibility check on a persisted session row, before pagination or aggregation. */
export function visibleSessionsPredicate(
  alias: string,
  viewer: SessionViewer,
  options: { mode: TeamsEnforcementMode; excludePrivate?: boolean }
): { sql: string; params: unknown[] } {
  if (viewer.kind === "service") {
    if (options.mode !== "on") return { sql: `${alias}.visibility != 'private'`, params: [] };
    return viewer.teamId === null
      ? { sql: `${alias}.visibility != 'private'`, params: [] }
      : {
          sql: `(${alias}.visibility = 'workspace' OR (${alias}.visibility = 'team' AND ${alias}.owner_team_id = ?))`,
          params: [viewer.teamId],
        };
  }

  const teamsEnforced = options.mode === "on";
  const teamSql = teamsEnforced
    ? `(${alias}.visibility = 'team' AND (? = 1 OR EXISTS (
         SELECT 1 FROM team_memberships tm
         WHERE tm.team_id = ${alias}.owner_team_id AND tm.user_id = ?)) )`
    : `${alias}.visibility != 'private'`;
  const params: unknown[] = teamsEnforced
    ? [isWorkspaceAdmin(viewer.roleKey) ? 1 : 0, viewer.userId]
    : [];
  if (options.excludePrivate) {
    return {
      sql: teamsEnforced ? `(${alias}.visibility = 'workspace' OR ${teamSql})` : teamSql,
      params,
    };
  }
  // Mirrors the resolver: team-owned collaborator grants require current team membership.
  const privateSql = `(${alias}.visibility = 'private' AND (${alias}.user_id = ? OR EXISTS (
    SELECT 1 FROM session_collaborators sc WHERE sc.session_id = ${alias}.id AND sc.user_id = ?
      AND (${alias}.owner_team_id IS NULL OR EXISTS (
        SELECT 1 FROM team_memberships ctm
        WHERE ctm.team_id = ${alias}.owner_team_id AND ctm.user_id = sc.user_id)))))`;
  params.push(viewer.userId, viewer.userId);
  return {
    sql: teamsEnforced
      ? `(${alias}.visibility = 'workspace' OR ${teamSql} OR ${privateSql})`
      : `(${teamSql} OR ${privateSql})`,
    params,
  };
}
