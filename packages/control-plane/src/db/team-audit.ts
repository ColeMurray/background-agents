import type { AuditOperationAction } from "@open-inspect/shared/types/audit-events";
import type { SqlDatabase, SqlStatement } from "./sql-database";

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
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
           action, resource_type, resource_id, target_user_id_snapshot, team_id,
           reason_code, operation_result, metadata_json)
          SELECT ?, ?, ?, 'user', ?, ?, 'team', ?, ?, ?, ?, 'applied', ?
          ${onlyIfPreviousChanged ? "WHERE changes() = 1" : ""}`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.requestId,
        input.actorUserId,
        input.action,
        input.teamId,
        input.targetUserId ?? null,
        input.teamId,
        input.action,
        JSON.stringify({ before: input.before ?? {}, requested: {}, after: input.after ?? {} })
      );
  }
}
