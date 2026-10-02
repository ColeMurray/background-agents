import type { PermissionId } from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";

/** Current role grants, suspension and membership are evaluated inside the committing statement. */
export function projectAccessPredicate(userId: string, need: "read" | "manage", alias = "p") {
  const read = rolePermissionPredicate("projects.read");
  const any = rolePermissionPredicate("projects.manage.any");
  const own = rolePermissionPredicate("projects.manage.own");
  return {
    sql: `EXISTS (SELECT 1 FROM users u JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id WHERE u.id = ? AND u.suspended_at IS NULL AND ${read.sql}
      AND (${alias}.owner_team_id IS NULL OR r.key IN ('owner', 'administrator') OR EXISTS (
        SELECT 1 FROM team_memberships tm WHERE tm.team_id = ${alias}.owner_team_id AND tm.user_id = u.id))
      ${
        need === "manage"
          ? `AND (${any.sql} OR (${own.sql} AND (${alias}.owner_user_id = u.id OR EXISTS (
        SELECT 1 FROM team_memberships lead WHERE lead.team_id = ${alias}.owner_team_id AND lead.user_id = u.id AND lead.role = 'lead'))))`
          : ""
      })`,
    params: [userId, ...read.values, ...(need === "manage" ? [...any.values, ...own.values] : [])],
  };
}

export function activePermissionPredicate(userId: string, permissions: PermissionId[]) {
  const guards = permissions.map(rolePermissionPredicate);
  return {
    sql: `EXISTS (SELECT 1 FROM users u JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id WHERE u.id = ? AND u.suspended_at IS NULL AND ${guards.map((g) => g.sql).join(" AND ")})`,
    params: [userId, ...guards.flatMap((g) => g.values)],
  };
}
