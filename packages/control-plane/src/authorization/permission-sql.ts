import {
  BUILT_IN_ROLE_KEYS,
  isCustomRolePermission,
  permissionsForBuiltInRole,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { sql, type SqlFragment } from "../db/sql-fragment";

/** A role predicate over `roles r` that enforces built-in and custom-role grant rules. */
export function rolePermissionFragment(permission: PermissionId): SqlFragment {
  const builtInRoles = BUILT_IN_ROLE_KEYS.filter((role) =>
    permissionsForBuiltInRole(role).includes(permission)
  );
  const customRoleSql = isCustomRolePermission(permission)
    ? sql`r.key IS NULL AND EXISTS (
        SELECT 1 FROM role_permissions custom_permission
        WHERE custom_permission.role_id = r.id
          AND custom_permission.permission_id = ${permission}
      )`
    : sql`0`;
  const builtInRoleList = sql.join(
    builtInRoles.map((role) => sql`${role}`),
    ", "
  );
  return sql`(r.key IN (${builtInRoleList})
      OR (${customRoleSql}))`;
}

/** {@link rolePermissionFragment} as text and values, for queries not built with `sql`. */
export function rolePermissionPredicate(permission: PermissionId): {
  sql: string;
  values: string[];
} {
  const predicate = rolePermissionFragment(permission);
  return { sql: predicate.text, values: predicate.values as string[] };
}
