import type { ExternalActionState } from "@open-inspect/shared";
import type { SqlDatabase } from "./sql-database";

/**
 * Who made the decision.
 *
 * A human decision names the user. A decision the system made on its own —
 * an approval that expired — names a service, so the audit trail never
 * attributes a system action to a user who did not make it.
 */
export type ExternalActionAuditActor =
  { kind: "user"; userId: string } | { kind: "service"; service: string };

export interface ExternalActionAuditInput {
  requestId: string;
  actor: ExternalActionAuditActor;
  action: "external_action.approved" | "external_action.denied" | "external_action.cancelled";
  actionId: string;
  sessionId: string;
  teamId: string | null;
  beforeState: ExternalActionState;
  afterState: ExternalActionState;
  revision: number;
  /** When the decision happened. */
  occurredAt: number;
}

/** Durable workspace audit projection of a SessionDO-authoritative decision. */
export class ExternalActionAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  async write(input: ExternalActionAuditInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO authorization_audit_events
         (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
          actor_service_snapshot, action, resource_type, resource_id, team_id, reason_code,
          operation_result, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'external_action', ?, ?, ?, 'applied', ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        `external-action:${input.actionId}:${input.revision}:${input.action}`,
        input.occurredAt,
        input.requestId,
        input.actor.kind,
        input.actor.kind === "user" ? input.actor.userId : null,
        input.actor.kind === "service" ? input.actor.service : null,
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
