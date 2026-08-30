import type { PermissionScope } from "@open-inspect/shared/rbac";
import type { SqlDatabase } from "./sql-database";

type SessionRelation = "creator" | "participant";
export type SessionRequiredRelation = "access" | "creator";
type SessionAccessErrorCode = "creator_required" | "session_access_required";

export class SessionAccessError extends Error {
  constructor(readonly code: SessionAccessErrorCode) {
    super(code);
    this.name = "SessionAccessError";
  }
}

export function sessionAccessPredicate(
  sessionAlias: string,
  userId: string,
  scope: PermissionScope
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

export async function requireSessionAccess(
  db: SqlDatabase,
  sessionId: string,
  userId: string,
  requiredRelation: SessionRequiredRelation
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT relation FROM session_access
       WHERE session_id = ? AND user_id = ?`
    )
    .bind(sessionId, userId)
    .first<{ relation: SessionRelation }>();
  if (requiredRelation === "creator" && row?.relation !== "creator") {
    throw new SessionAccessError("creator_required");
  }
  if (!row) throw new SessionAccessError("session_access_required");
}

export async function activateSessionParticipantAccess(
  db: SqlDatabase,
  sessionId: string,
  userId: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO session_access (session_id, user_id, relation)
       VALUES (?, ?, 'participant')
       ON CONFLICT(session_id, user_id) DO NOTHING`
    )
    .bind(sessionId, userId)
    .run();
}
