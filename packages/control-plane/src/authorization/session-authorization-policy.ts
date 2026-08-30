import {
  resolveScopedPermission,
  type EffectiveAuthorization,
  type PermissionScope,
  type ScopedPermissionStem,
} from "@open-inspect/shared/rbac";
import type { SessionRequiredRelation } from "../db/session-access";
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
