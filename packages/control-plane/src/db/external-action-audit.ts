import type { ExternalActionState } from "@open-inspect/shared";
import type { SqlDatabase } from "./sql-database";

export interface ExternalActionAuditInput {
  requestId: string;
  actorUserId: string;
  action: "external_action.approved" | "external_action.denied";
  actionId: string;
  sessionId: string;
  teamId: string | null;
  beforeState: ExternalActionState;
  afterState: ExternalActionState;
  revision: number;
}

/** Durable workspace audit projection of a SessionDO-authoritative decision. */
export class ExternalActionAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  async write(input: ExternalActionAuditInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO authorization_audit_events
         (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
          action, resource_type, resource_id, team_id, reason_code, operation_result, metadata_json)
         VALUES (?, ?, ?, 'user', ?, ?, 'external_action', ?, ?, ?, 'applied', ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        `external-action:${input.actionId}:${input.revision}:${input.action}`,
        Date.now(),
        input.requestId,
        input.actorUserId,
        input.action,
        input.actionId,
        input.teamId,
        input.action,
        JSON.stringify({
          before: { state: input.beforeState, sessionId: input.sessionId },
          requested: { state: input.afterState },
          after: { state: input.afterState, revision: input.revision },
        })
      )
      .run();
  }
}
