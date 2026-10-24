import type { SqlDatabase, SqlStatement } from "./sql-database";
import type { BoundAppliedAuditEvent } from "./team-audit";

interface GuardedReassignmentInput {
  readonly executorUpdate: SqlStatement;
  readonly audit: BoundAppliedAuditEvent;
  readonly automationId: string;
  readonly revokedAt: number;
}

interface BulkReassignmentInput {
  readonly executorUpdate: SqlStatement;
  readonly automationId: string | null;
  readonly previousExecutorUserId: string | null;
  readonly nextExecutorUserId: string;
  readonly revokedAt: number;
}

/**
 * Atomic statement bundles for every production write to `automations.user_id`.
 *
 * Callers must batch the returned bundle as-is. The guarded form deliberately orders the executor
 * UPDATE immediately before its conditional audit, then revokes grants only when that audit row
 * exists and the persisted executor differs. The bulk form revokes grants for every automation
 * still owned by the old executor before updating those same rows in the same transaction.
 */
export class AutomationExecutorReassignmentStore {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  bindGuardedReassignment(input: GuardedReassignmentInput): SqlStatement[] {
    return [
      input.executorUpdate,
      input.audit.statement,
      this.db
        .prepare(
          `UPDATE automation_external_action_grants
           SET revoked_at = ?, revoked_reason = 'executor_changed'
           WHERE automation_id = ? AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM automations
               WHERE automations.id = automation_external_action_grants.automation_id
                 AND automations.user_id IS DISTINCT FROM
                     automation_external_action_grants.executor_user_id
             )
             AND EXISTS (
               SELECT 1 FROM authorization_audit_events WHERE id = ?
             )`
        )
        .bind(input.revokedAt, input.automationId, input.audit.id),
    ];
  }

  bindBulkReassignment(input: BulkReassignmentInput): SqlStatement[] {
    const automationScope = input.automationId === null ? "" : "AND automations.id = ?";
    const bindings = [
      input.revokedAt,
      input.nextExecutorUserId,
      input.previousExecutorUserId,
      ...(input.automationId === null ? [] : [input.automationId]),
    ];
    return [
      this.db
        .prepare(
          `UPDATE automation_external_action_grants
           SET revoked_at = ?, revoked_reason = 'executor_changed'
           WHERE revoked_at IS NULL
             AND executor_user_id IS DISTINCT FROM ?
             AND EXISTS (
               SELECT 1 FROM automations
               WHERE automations.id = automation_external_action_grants.automation_id
                 AND automations.user_id IS NOT DISTINCT FROM ?
                 ${automationScope}
             )`
        )
        .bind(...bindings),
      input.executorUpdate,
    ];
  }
}
