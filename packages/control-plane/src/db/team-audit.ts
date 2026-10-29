import type { AuditOperationAction } from "@open-inspect/shared/types/audit-events";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/** One applied user operation on an owned resource. */
export interface AppliedAuditEvent {
  requestId: string;
  actorUserId: string;
  action: AuditOperationAction;
  resourceType: "team" | "automation";
  resourceId: string;
  teamId: string | null;
  targetUserId?: string;
  before: unknown;
  after: unknown;
}

/**
 * Build the audit insert for an applied operation. With `onlyIfPreviousChanged`, the row is
 * written only when the preceding statement in the same batch changed a row.
 */
export function bindAppliedAuditEvent(
  db: SqlDatabase,
  event: AppliedAuditEvent,
  onlyIfPreviousChanged = false
): SqlStatement {
  return db
    .prepare(
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
         action, resource_type, resource_id, target_user_id_snapshot, team_id,
         reason_code, operation_result, metadata_json)
        SELECT ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 'applied', ?
        ${onlyIfPreviousChanged ? "WHERE changes() = 1" : ""}`
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      event.requestId,
      event.actorUserId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.targetUserId ?? null,
      event.teamId,
      event.action,
      JSON.stringify({ before: event.before ?? {}, requested: {}, after: event.after ?? {} })
    );
}

export interface TeamAuditInput {
  requestId: string;
  actorUserId: string;
  action: Extract<AuditOperationAction, `team.${string}`>;
  teamId: string;
  targetUserId?: string;
  before: unknown;
  after: unknown;
}

export type TeamAuditActor = Pick<TeamAuditInput, "requestId" | "actorUserId">;

export class TeamAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  bind(input: TeamAuditInput, onlyIfPreviousChanged = false): SqlStatement {
    return bindAppliedAuditEvent(
      this.db,
      { ...input, resourceType: "team", resourceId: input.teamId },
      onlyIfPreviousChanged
    );
  }
}
