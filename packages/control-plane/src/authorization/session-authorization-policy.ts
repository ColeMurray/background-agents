import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionAuthorizationOperation } from "../routes/shared";

export type SessionRelation = "creator" | "participant";
export type SessionPermissionScope = "any" | "own";
export type SessionRelationshipError = "creator_required" | "session_access_required";

const OPERATION_DEFINITIONS: Record<
  SessionAuthorizationOperation,
  { permissionStem: `sessions.${string}`; requiredRelation: "access" | "creator" }
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
  if (authorization.permissions.includes(`${permissionStem}.any` as PermissionId)) return "any";
  if (authorization.permissions.includes(`${permissionStem}.own` as PermissionId)) return "own";
  return null;
}

export function sessionRelationshipDecision(
  operation: SessionAuthorizationOperation,
  scope: SessionPermissionScope,
  relation: SessionRelation | null
): { allowed: true } | { allowed: false; code: SessionRelationshipError } {
  if (scope === "any") return { allowed: true };
  if (OPERATION_DEFINITIONS[operation].requiredRelation === "creator") {
    return relation === "creator"
      ? { allowed: true }
      : { allowed: false, code: "creator_required" };
  }
  return relation ? { allowed: true } : { allowed: false, code: "session_access_required" };
}

export async function getSessionRelation(
  db: SqlDatabase,
  sessionId: string,
  userId: string
): Promise<SessionRelation | null> {
  const row = await db
    .prepare(
      `SELECT relation FROM session_access
       WHERE session_id = ? AND user_id = ?`
    )
    .bind(sessionId, userId)
    .first<{ relation: SessionRelation }>();
  return row?.relation ?? null;
}

export function sessionAccessPredicate(
  sessionAlias: string,
  userId: string,
  scope: SessionPermissionScope
): { sql: string; params: string[] } {
  if (scope === "any") return { sql: "1 = 1", params: [] };
  return {
    sql: `EXISTS (
      SELECT 1 FROM session_access access
      WHERE access.session_id = ${sessionAlias}.id AND access.user_id = ?
    )`,
    params: [userId],
  };
}
