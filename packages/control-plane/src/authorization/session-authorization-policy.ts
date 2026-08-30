import { type PermissionId } from "@open-inspect/shared/rbac";
import { AuthorizationError, AuthorizationService } from "./service";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionAuthorizationOperation } from "../routes/shared";

const OPERATION_PERMISSIONS: Record<SessionAuthorizationOperation, PermissionId> = {
  read: "sessions.read",
  collaborate: "sessions.collaborate",
  lifecycle: "sessions.lifecycle",
  sandbox_access: "sessions.sandbox_access",
  delete: "sessions.delete",
};

export function sessionPermission(operation: SessionAuthorizationOperation): PermissionId {
  return OPERATION_PERMISSIONS[operation];
}

export async function verifySessionAuthorization(
  db: SqlDatabase,
  userId: string,
  operation: SessionAuthorizationOperation
): Promise<"valid" | "rejected"> {
  try {
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(userId);
    if (authorization.suspendedAt !== null) return "rejected";
    return authorization.permissions.includes(sessionPermission(operation)) ? "valid" : "rejected";
  } catch (error) {
    if (error instanceof AuthorizationError) return "rejected";
    throw error;
  }
}
