import {
  SCOPED_PERMISSION_PAIRS,
  type EffectiveAuthorization,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import { predicateHolds, type GuardedWrite, type SqlPredicate } from "../db/guarded-write";
import type { SqlDatabase } from "../db/sql-database";

export type AutomationAuthorizationOperation = "manage" | "trigger";
export const AUTOMATION_EXECUTION_GUARD = "automation_execution_authorization";
export const AUTOMATION_REQUEST_GUARD = "automation_request_authorization";
const PERMISSION_SET_GUARD = "permission_set_authorization";

function executionPredicate(
  automationId: string,
  requiredAnyOf: readonly PermissionId[] = []
): SqlPredicate {
  const createGuard = rolePermissionPredicate("sessions.create");
  const repositoryGuard = rolePermissionPredicate("repositories.use");
  const environmentGuard = rolePermissionPredicate("environments.use");
  const additionalGuards = requiredAnyOf.map(rolePermissionPredicate);
  return {
    sql: `EXISTS (
      SELECT 1 FROM automations a
      JOIN users u ON u.id = a.user_id
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE a.id = ? AND a.deleted_at IS NULL AND u.suspended_at IS NULL
        AND ${createGuard.sql}
        AND (
          NOT EXISTS (SELECT 1 FROM automation_repositories ar WHERE ar.automation_id = a.id)
          OR ${repositoryGuard.sql}
        )
        AND (
          NOT EXISTS (SELECT 1 FROM automation_environments ae WHERE ae.automation_id = a.id)
          OR ${environmentGuard.sql}
        )
        ${additionalGuards.length > 0 ? `AND (${additionalGuards.map((guard) => guard.sql).join(" OR ")})` : ""}
    )`,
    values: [
      automationId,
      ...createGuard.values,
      ...repositoryGuard.values,
      ...environmentGuard.values,
      ...additionalGuards.flatMap((guard) => guard.values),
    ],
  };
}

function authPredicate(
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation,
  requiredPermissions: readonly PermissionId[]
): SqlPredicate {
  const permissionPair = SCOPED_PERMISSION_PAIRS[`automations.${operation}`];
  const anyGuard = rolePermissionPredicate(permissionPair.any);
  const ownGuard = rolePermissionPredicate(permissionPair.own);
  const requiredPermissionGuards = requiredPermissions.map(rolePermissionPredicate);
  return {
    sql: `EXISTS (
      SELECT 1 FROM users u
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE u.id = ? AND u.suspended_at IS NULL
        AND EXISTS (
          SELECT 1 FROM automations a
          WHERE a.id = ? AND a.deleted_at IS NULL
            AND (${anyGuard.sql} OR (${ownGuard.sql} AND a.user_id = u.id))
        )
        ${requiredPermissionGuards.length > 0 ? `AND ${requiredPermissionGuards.map((guard) => guard.sql).join(" AND ")}` : ""}
    )`,
    values: [
      authorization.userId,
      automationId,
      ...anyGuard.values,
      ...ownGuard.values,
      ...requiredPermissionGuards.flatMap((guard) => guard.values),
    ],
  };
}

function permissionSetPredicate(
  authorization: EffectiveAuthorization,
  permissions: readonly PermissionId[]
): SqlPredicate {
  const permissionGuards = permissions.map(rolePermissionPredicate);
  return {
    sql: `EXISTS (
      SELECT 1 FROM users u
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE u.id = ? AND u.suspended_at IS NULL
        AND ${permissionGuards.map((guard) => guard.sql).join(" AND ")}
    )`,
    values: [authorization.userId, ...permissionGuards.flatMap((guard) => guard.values)],
  };
}

export function automationExecutionGuard(automationId: string): GuardedWrite {
  return { name: AUTOMATION_EXECUTION_GUARD, predicate: executionPredicate(automationId) };
}

export function automationAuthorizationGuard(
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation,
  requiredPermissions: readonly PermissionId[] = []
): GuardedWrite {
  return {
    name: AUTOMATION_REQUEST_GUARD,
    predicate: authPredicate(automationId, authorization, operation, requiredPermissions),
  };
}

export function permissionSetGuard(
  authorization: EffectiveAuthorization,
  permissions: readonly PermissionId[]
): GuardedWrite {
  return {
    name: PERMISSION_SET_GUARD,
    predicate: permissionSetPredicate(authorization, permissions),
  };
}

export async function isAutomationExecutionAuthorized(
  db: SqlDatabase,
  automationId: string,
  requiredAnyOf: readonly PermissionId[] = []
): Promise<boolean> {
  return predicateHolds(db, executionPredicate(automationId, requiredAnyOf));
}
