import { generateId } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export interface PersonalMemoryRead {
  requestId: string;
  sessionId: string;
  /** The account behind the prompt the agent was serving. */
  promptAuthorUserId: string | null;
  /** Whose personal memory was read. */
  ownerUserId: string | null;
  memoryIds: readonly string[];
}

/**
 * Audit rows for personal memory reaching a session, which no memory record change captures: one
 * per sandbox request that returns personal records. Rows carry IDs, never memory content.
 */
export class PersonalMemoryAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  async recordRead(input: PersonalMemoryRead): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action,
         resource_type, resource_id, target_user_id_snapshot, reason_code, operation_result,
         metadata_json)
        VALUES (?, ?, ?, 'sandbox', ?, 'memory.personal_read', 'session', ?, ?,
          'memory.personal_read', 'applied', ?)`
      )
      .bind(
        generateId(),
        Date.now(),
        input.requestId,
        input.promptAuthorUserId,
        input.sessionId,
        input.ownerUserId,
        JSON.stringify({ before: {}, requested: {}, after: { memoryIds: input.memoryIds } })
      )
      .run();
  }
}
