import type { AccessDenialReason, SessionAccessRow } from "@open-inspect/shared";
import { hashToken } from "../auth/crypto";
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

/** One subscribe/lease per connection ID; the primary key deduplicates after hibernation. */
export async function auditSocketShadowDenied(
  db: SqlDatabase,
  actorUserId: string,
  row: SessionAccessRow,
  reason: AccessDenialReason,
  connectionId: string
): Promise<void> {
  const id = `ws-shadow-${await hashToken(JSON.stringify([connectionId, row.id, reason]))}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
         actor_service_snapshot, action, resource_type, resource_id, team_id,
         reason_code, operation_result, metadata_json)
       VALUES (?, ?, ?, 'user', ?, NULL, 'session.shadow_denied', 'session',
               ?, ?, ?, 'denied', ?)`
    )
    .bind(
      id,
      Date.now(),
      connectionId,
      actorUserId,
      row.id,
      row.ownerTeamId,
      `shadow_denied:${reason}`,
      JSON.stringify({ before: {}, requested: {}, after: {}, channel: "ws" })
    )
    .run();
}
