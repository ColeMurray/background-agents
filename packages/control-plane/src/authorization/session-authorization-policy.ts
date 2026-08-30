import {
  resolveScopedPermission,
  type EffectiveAuthorization,
  type PermissionScope,
  type ScopedPermissionStem,
} from "@open-inspect/shared/rbac";
import { AuthorizationError, AuthorizationService } from "./service";
import {
  requireSessionAccess,
  SessionAccessError,
  type SessionRequiredRelation,
} from "../db/session-access";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionAuthorizationOperation } from "../routes/shared";

export type SessionPermissionScope = PermissionScope;

const OPERATION_DEFINITIONS: Record<
  SessionAuthorizationOperation,
  { permissionStem: ScopedPermissionStem; requiredRelation: SessionRequiredRelation }
> = {
  read: { permissionStem: "sessions.read", requiredRelation: "access" },
  collaborate: { permissionStem: "sessions.collaborate", requiredRelation: "access" },
  lifecycle: { permissionStem: "sessions.lifecycle", requiredRelation: "access" },
  "participants.manage": {
    permissionStem: "sessions.participants.manage",
    requiredRelation: "creator",
  },
  sandbox_access: { permissionStem: "sessions.sandbox_access", requiredRelation: "access" },
  delete: { permissionStem: "sessions.delete", requiredRelation: "creator" },
};

export function sessionPermissionScope(
  authorization: EffectiveAuthorization,
  operation: SessionAuthorizationOperation
): SessionPermissionScope | null {
  const { permissionStem } = OPERATION_DEFINITIONS[operation];
  return resolveScopedPermission(permissionStem, authorization.permissions);
}

export function sessionPermissionStem(
  operation: SessionAuthorizationOperation
): ScopedPermissionStem {
  return OPERATION_DEFINITIONS[operation].permissionStem;
}

export function sessionRequiredRelation(
  operation: SessionAuthorizationOperation
): SessionRequiredRelation {
  return OPERATION_DEFINITIONS[operation].requiredRelation;
}

export async function verifySessionAuthorization(
  db: SqlDatabase,
  userId: string,
  sessionId: string,
  operation: SessionAuthorizationOperation
): Promise<"valid" | "rejected"> {
  try {
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(userId);
    if (authorization.suspendedAt !== null) return "rejected";
    const scope = sessionPermissionScope(authorization, operation);
    if (!scope) return "rejected";
    if (scope === "own") {
      await requireSessionAccess(db, sessionId, userId, sessionRequiredRelation(operation));
    }
    return "valid";
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof SessionAccessError) {
      return "rejected";
    }
    throw error;
  }
}
