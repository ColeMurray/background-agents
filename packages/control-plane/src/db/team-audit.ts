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

export class TeamAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  bind(input: TeamAuditInput): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
           action, resource_type, resource_id, target_user_id_snapshot, team_id,
           reason_code, operation_result, metadata_json)
         VALUES (?, ?, ?, 'user', ?, ?, 'team', ?, ?, ?, ?, 'applied', ?)`
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

  async write(input: TeamAuditInput): Promise<void> {
    await this.bind(input).run();
  }
}
