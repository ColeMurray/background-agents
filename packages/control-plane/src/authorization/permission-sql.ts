import {
  BUILT_IN_ROLE_KEYS,
  isCustomRolePermission,
  permissionsForBuiltInRole,
  type PermissionId,
} from "@open-inspect/shared/rbac";

/** Builds a parameterized role predicate that enforces built-in and custom-role grant rules. */
export function rolePermissionPredicate(permission: PermissionId): {
  sql: string;
  values: string[];
} {
  const builtInRoles = BUILT_IN_ROLE_KEYS.filter((role) =>
    permissionsForBuiltInRole(role).includes(permission)
  );
  const customRolePermission = isCustomRolePermission(permission);
  const customRoleSql = customRolePermission
    ? `r.key IS NULL AND EXISTS (
        SELECT 1 FROM role_permissions custom_permission
        WHERE custom_permission.role_id = r.id
          AND custom_permission.permission_id = ?
      )`
    : "0";
  return {
    sql: `(r.key IN (${builtInRoles.map(() => "?").join(", ")})
      OR (${customRoleSql}))`,
    values: [...builtInRoles, ...(customRolePermission ? [permission] : [])],
  };
}
