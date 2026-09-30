import { auditEventSchema, type AuditEvent } from "@open-inspect/shared/types/audit-events";
import type { AuditEventCursor } from "./audit-event-cursor";
import type { SqlDatabase } from "./sql-database";
import type { SessionViewer } from "@open-inspect/shared";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";
import { visibleSessionsPredicate } from "./session-visibility";

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

/** Read-only access for workspace audit and visibility-scoped team activity. */
export class AuditEventStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(options: {
    limit: number;
    cursor: AuditEventCursor | null;
    teamId?: string;
    action?: string;
    visibilityScope?: { viewer: SessionViewer; mode: TeamsEnforcementMode };
  }) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.teamId !== undefined) {
      conditions.push("audit.team_id = ?");
      params.push(options.teamId);
    }
    if (options.action !== undefined) {
      conditions.push("audit.action = ?");
      params.push(options.action);
    }
    if (options.visibilityScope) {
      const viewer = options.visibilityScope.viewer;
      const visible = visibleSessionsPredicate("session", viewer, {
        mode: options.visibilityScope.mode,
      });
      // Session HTTP decisions can reference additional sessions in metadata. Without
      // structured resource IDs for every reference, omit them from the team feed.
      conditions.push(`(
        (audit.resource_type != 'session' AND (
          audit.resource_type != 'http_route' OR audit.resource_id IS NULL OR NOT (
            audit.resource_id = '/sessions' OR audit.resource_id LIKE '/sessions/%'
          )
        )) OR (
          audit.resource_type = 'session' AND EXISTS (
            SELECT 1 FROM sessions session
            WHERE session.id = audit.resource_id AND ? = 1 AND ${visible.sql}
          )
        )
      )`);
      params.push(
        viewer.kind === "service" ||
          (!viewer.suspended && viewer.permissions.includes("sessions.read"))
          ? 1
          : 0,
        ...visible.params
      );
    }
    if (options.cursor) {
      conditions.push("(audit.occurred_at, audit.id) < (?, ?)");
      params.push(options.cursor.occurredAt, options.cursor.id);
    }
    const result = await this.db
      .prepare(
        `SELECT audit.* FROM authorization_audit_events audit
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY audit.occurred_at DESC, audit.id DESC LIMIT ?`
      )
      .bind(...params, options.limit + 1)
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
