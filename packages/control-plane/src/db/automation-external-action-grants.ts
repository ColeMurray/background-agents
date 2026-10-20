import type { SqlDatabase } from "./sql-database";
import {
  PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
  assertMigrationReservation,
} from "@open-inspect/shared/pi-migration-reservations";

export const AUTOMATION_EXTERNAL_ACTION_GRANTS_MIGRATION_VERSION =
  PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION;

assertMigrationReservation({
  store: "d1",
  version: AUTOMATION_EXTERNAL_ACTION_GRANTS_MIGRATION_VERSION,
  feature: "externalActions",
});

export interface AutomationExternalActionGrant {
  id: string;
  automationId: string;
  executorUserId: string;
  provider: string;
  action: string;
  createdBy: string;
  createdAt: number;
}

interface GrantRow {
  id: string;
  automation_id: string;
  executor_user_id: string;
  provider: string;
  action: string;
  created_by: string;
  created_at: number;
}

/** D1 authority for executor-scoped unattended external-action grants. */
export class AutomationExternalActionGrantStore {
  constructor(private readonly db: SqlDatabase) {}

  async create(grant: AutomationExternalActionGrant): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO automation_external_action_grants (
           id, automation_id, executor_user_id, provider, action, created_by, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
         FROM automations
         JOIN users executor ON executor.id = automations.user_id
         WHERE automations.id = ? AND automations.deleted_at IS NULL
           AND automations.user_id = ? AND executor.suspended_at IS NULL`
      )
      .bind(
        grant.id,
        grant.automationId,
        grant.executorUserId,
        grant.provider,
        grant.action,
        grant.createdBy,
        grant.createdAt,
        grant.automationId,
        grant.executorUserId
      )
      .run();
    return result.meta.changes === 1;
  }

  async findActive(
    automationId: string,
    executorUserId: string,
    provider: string,
    action: string
  ): Promise<AutomationExternalActionGrant | null> {
    const row = await this.db
      .prepare(
        `SELECT grant_row.id, grant_row.automation_id, grant_row.executor_user_id,
                grant_row.provider, grant_row.action, grant_row.created_by, grant_row.created_at
         FROM automation_external_action_grants grant_row
         JOIN automations automation ON automation.id = grant_row.automation_id
         JOIN users executor ON executor.id = grant_row.executor_user_id
         WHERE grant_row.automation_id = ? AND grant_row.executor_user_id = ?
           AND grant_row.provider = ? AND grant_row.action = ?
           AND grant_row.revoked_at IS NULL AND automation.deleted_at IS NULL
           AND automation.user_id = grant_row.executor_user_id
           AND executor.suspended_at IS NULL`
      )
      .bind(automationId, executorUserId, provider, action)
      .first<GrantRow>();
    return row ? toGrant(row) : null;
  }

  /** Every grant the automation holds, revoked ones included, oldest first. */
  async listByAutomation(automationId: string): Promise<AutomationExternalActionGrant[]> {
    const rows = await this.db
      .prepare(
        `SELECT grant_row.id, grant_row.automation_id, grant_row.executor_user_id,
                grant_row.provider, grant_row.action, grant_row.created_by, grant_row.created_at
         FROM automation_external_action_grants grant_row
         WHERE grant_row.automation_id = ?
         ORDER BY grant_row.created_at, grant_row.id`
      )
      .bind(automationId)
      .all<GrantRow>();
    return rows.results.map((row) => toGrant(row));
  }

  /**
   * Revoke one grant.
   *
   * The automation id is part of the statement, so a caller can never revoke
   * a grant that belongs to another automation.
   */
  async revoke(
    id: string,
    revokedAt: number,
    reason: string,
    automationId?: string
  ): Promise<boolean> {
    const result = automationId
      ? await this.db
          .prepare(
            `UPDATE automation_external_action_grants
             SET revoked_at = ?, revoked_reason = ?
             WHERE id = ? AND revoked_at IS NULL AND automation_id = ?`
          )
          .bind(revokedAt, reason, id, automationId)
          .run()
      : await this.db
          .prepare(
            `UPDATE automation_external_action_grants
             SET revoked_at = ?, revoked_reason = ?
             WHERE id = ? AND revoked_at IS NULL`
          )
          .bind(revokedAt, reason, id)
          .run();
    return result.meta.changes === 1;
  }
}

function toGrant(row: GrantRow): AutomationExternalActionGrant {
  return {
    id: row.id,
    automationId: row.automation_id,
    executorUserId: row.executor_user_id,
    provider: row.provider,
    action: row.action,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
