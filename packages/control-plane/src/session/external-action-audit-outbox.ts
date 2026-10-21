import type { ExternalActionAuditInput } from "../db/external-action-audit";
import type { SqlStorage, TransactionSync } from "./sql-storage";

const MAX_RETRY_MS = 60_000;

interface AuditOutboxRow {
  id: string;
  action_id: string;
  revision: number;
  request_id: string;
  actor_user_id: string;
  actor_kind: "user" | "service";
  action: ExternalActionAuditInput["action"];
  session_id: string;
  before_state: ExternalActionAuditInput["beforeState"];
  after_state: ExternalActionAuditInput["afterState"];
  attempts: number;
  next_attempt_at: number;
  occurred_at: number | null;
}

export type ExternalActionAuditProjector = (
  input: Omit<ExternalActionAuditInput, "teamId">
) => Promise<void>;

/** Durable SessionDO outbox for the non-atomic D1 audit projection. */
export class ExternalActionAuditOutbox {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: TransactionSync,
    private readonly now: () => number = Date.now
  ) {}

  nextDeadline(): number | null {
    const row = this.sql
      .exec("SELECT MIN(next_attempt_at) AS deadline FROM external_action_audit_outbox")
      .toArray()[0] as { deadline: number | null } | undefined;
    return row?.deadline ?? null;
  }

  async flush(project: ExternalActionAuditProjector, at = this.now()): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT * FROM external_action_audit_outbox
         WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 25`,
        at
      )
      .toArray() as unknown as AuditOutboxRow[];
    for (const row of rows) {
      try {
        await project({
          requestId: row.request_id,
          actor:
            row.actor_kind === "service"
              ? { kind: "service", service: row.actor_user_id }
              : { kind: "user", userId: row.actor_user_id },
          action: row.action,
          actionId: row.action_id,
          sessionId: row.session_id,
          beforeState: row.before_state,
          afterState: row.after_state,
          revision: row.revision,
          // The decision's own time, not the time the projection managed to
          // flush. A delayed audit must still say when the decision happened.
          occurredAt: row.occurred_at ?? row.next_attempt_at,
        });
        this.transaction(() => {
          this.sql.exec("DELETE FROM external_action_audit_outbox WHERE id = ?", row.id);
        });
      } catch {
        const attempts = row.attempts + 1;
        const retryMs = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(attempts - 1, 6));
        this.transaction(() => {
          this.sql.exec(
            `UPDATE external_action_audit_outbox
             SET attempts = ?, next_attempt_at = ? WHERE id = ?`,
            attempts,
            at + retryMs,
            row.id
          );
        });
      }
    }
  }
}
