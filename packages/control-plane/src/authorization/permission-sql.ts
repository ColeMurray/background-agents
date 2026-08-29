import { PERMISSION_REGISTRY, type PermissionId } from "@open-inspect/shared/rbac";

export function rolePermissionPredicate(permission: PermissionId): {
  sql: string;
  values: string[];
} {
  const builtInRoles = PERMISSION_REGISTRY[permission].builtInRoles;
  return {
    sql: `(r.key IN (${builtInRoles.map(() => "?").join(", ")})
      OR (r.key IS NULL AND EXISTS (
        SELECT 1 FROM role_permissions custom_permission
        WHERE custom_permission.role_id = r.id
          AND custom_permission.permission_id = ?
      )))`,
    values: [...builtInRoles, permission],
  };
}
