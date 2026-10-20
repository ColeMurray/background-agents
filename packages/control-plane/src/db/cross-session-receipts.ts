import type { SqlDatabase } from "./sql-database";
import {
  PI_D1_CROSS_SESSION_MESSAGING_MIGRATION_VERSION,
  assertMigrationReservation,
} from "@open-inspect/shared/pi-migration-reservations";

export const CROSS_SESSION_RECEIPTS_MIGRATION_VERSION =
  PI_D1_CROSS_SESSION_MESSAGING_MIGRATION_VERSION;

assertMigrationReservation({
  store: "d1",
  version: CROSS_SESSION_RECEIPTS_MIGRATION_VERSION,
  feature: "crossSessionMessaging",
});

export interface CrossSessionReceiptRecord {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  operationId: string;
  humanActorId: string;
  agentConversationId: string | null;
  sourceTaskId: string | null;
  depth: number;
  idempotencyKey: string;
  contentSha256: string;
  status: "pending" | "delivered" | "rejected";
  targetMessageId: string | null;
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReceiptRow {
  id: string;
  source_session_id: string;
  target_session_id: string;
  operation_id: string;
  human_actor_id: string;
  agent_conversation_id: string | null;
  source_task_id: string | null;
  depth: number;
  idempotency_key: string;
  content_sha256: string;
  status: CrossSessionReceiptRecord["status"];
  target_message_id: string | null;
  rejection_reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * D1 authority for cross-session message receipts.
 *
 * The receipt is the idempotency record: one request key produces one receipt,
 * so a retry never delivers the same message twice. The content hash is kept
 * so a reused key with different content is refused rather than delivered.
 */
export class CrossSessionReceiptStore {
  constructor(private readonly db: SqlDatabase) {}

  async findByIdempotencyKey(
    sourceSessionId: string,
    idempotencyKey: string
  ): Promise<CrossSessionReceiptRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, source_session_id, target_session_id, operation_id, human_actor_id, agent_conversation_id,
                source_task_id, depth, idempotency_key, content_sha256, status, target_message_id,
                rejection_reason, created_at, updated_at
         FROM cross_session_receipts
         WHERE source_session_id = ? AND idempotency_key = ?`
      )
      .bind(sourceSessionId, idempotencyKey)
      .first<ReceiptRow>();
    return row ? toRecord(row) : null;
  }

  async create(receipt: CrossSessionReceiptRecord): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO cross_session_receipts
           (id, source_session_id, target_session_id, operation_id, human_actor_id,
            agent_conversation_id, source_task_id, depth, idempotency_key, content_sha256, status,
            target_message_id, rejection_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_session_id, idempotency_key) DO NOTHING`
      )
      .bind(
        receipt.id,
        receipt.sourceSessionId,
        receipt.targetSessionId,
        receipt.operationId,
        receipt.humanActorId,
        receipt.agentConversationId,
        receipt.sourceTaskId,
        receipt.depth,
        receipt.idempotencyKey,
        receipt.contentSha256,
        receipt.status,
        receipt.targetMessageId,
        receipt.rejectionReason,
        receipt.createdAt,
        receipt.updatedAt
      )
      .run();
    return result.meta.changes === 1;
  }

  /** How many messages one turn already produced in this session. */
  async countForOperation(sourceSessionId: string, operationId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM cross_session_receipts
         WHERE source_session_id = ? AND operation_id = ?`
      )
      .bind(sourceSessionId, operationId)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async markDelivered(id: string, targetMessageId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE cross_session_receipts
         SET status = 'delivered', target_message_id = ?, rejection_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(targetMessageId, now, id)
      .run();
    return result.meta.changes === 1;
  }

  async markRejected(id: string, reason: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE cross_session_receipts
         SET status = 'rejected', rejection_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(reason, now, id)
      .run();
    return result.meta.changes === 1;
  }
}

function toRecord(row: ReceiptRow): CrossSessionReceiptRecord {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    operationId: row.operation_id,
    humanActorId: row.human_actor_id,
    agentConversationId: row.agent_conversation_id,
    sourceTaskId: row.source_task_id,
    depth: row.depth,
    idempotencyKey: row.idempotency_key,
    contentSha256: row.content_sha256,
    status: row.status,
    targetMessageId: row.target_message_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
