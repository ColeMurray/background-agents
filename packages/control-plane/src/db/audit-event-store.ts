import { auditEventSchema, type AuditEvent } from "@open-inspect/shared/types/audit-events";
import type { AuditEventCursor } from "./audit-event-cursor";
import type { SqlDatabase } from "./sql-database";

export interface AuditEventRow {
  id: string;
  occurred_at: number;
  request_id: string;
  principal_kind: string;
  actor_user_id_snapshot: string | null;
  actor_service_snapshot: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  target_user_id_snapshot: string | null;
  reason_code: string;
  operation_result: string;
  metadata_json: string;
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return auditEventSchema.parse({
    id: row.id,
    occurredAt: row.occurred_at,
    requestId: row.request_id,
    principalKind: row.principal_kind,
    actorUserIdSnapshot: row.actor_user_id_snapshot,
    actorServiceSnapshot: row.actor_service_snapshot,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    targetUserIdSnapshot: row.target_user_id_snapshot,
    reasonCode: row.reason_code,
    operationResult: row.operation_result,
    metadata: JSON.parse(row.metadata_json),
  });
}

/** Read-only D1 access for the workspace audit log. */
export class AuditEventStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(options: { limit: number; cursor: AuditEventCursor | null }) {
    const result = options.cursor
      ? await this.db
          .prepare(
            `SELECT * FROM authorization_audit_events
             WHERE (occurred_at, id) < (?, ?)
             ORDER BY occurred_at DESC, id DESC LIMIT ?`
          )
          .bind(options.cursor.occurredAt, options.cursor.id, options.limit + 1)
          .all<AuditEventRow>()
      : await this.db
          .prepare(
            `SELECT * FROM authorization_audit_events
             ORDER BY occurred_at DESC, id DESC LIMIT ?`
          )
          .bind(options.limit + 1)
          .all<AuditEventRow>();

    const rows = result.results ?? [];
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    if (!hasMore) return { rows: pageRows, hasMore: false as const, nextCursor: null };
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      hasMore: true as const,
      nextCursor: { occurredAt: last.occurred_at, id: last.id },
    };
  }
}
