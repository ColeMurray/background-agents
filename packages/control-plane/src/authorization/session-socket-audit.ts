import type { SessionAccessRow } from "@open-inspect/shared";
import type { SqlDatabase } from "../db/sql-database";

/** Persist the Owner's private-session read before the WebSocket snapshot is sent. */
export async function auditSocketPrivateBreakGlass(
  db: SqlDatabase,
  actorUserId: string,
  row: SessionAccessRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
         actor_service_snapshot, action, resource_type, resource_id, team_id,
         reason_code, operation_result, metadata_json)
       VALUES (?, ?, ?, 'user', ?, NULL, 'session.private_break_glass', 'session',
               ?, ?, 'session.private_break_glass', 'applied', ?)`
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      crypto.randomUUID(),
      actorUserId,
      row.id,
      row.ownerTeamId,
      JSON.stringify({ before: {}, requested: {}, after: {} })
    )
    .run();
}
