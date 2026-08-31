import {
  externalCreateSessionResponseSchema,
  type ExternalCreateSessionResponse,
} from "@open-inspect/shared/types/external-session-api";
import type { SqlDatabase } from "./sql-database";

type ExternalCreateStage = "reserved" | "session_created" | "completed";

interface ExternalCreateOperation {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  sessionId: string;
  stage: ExternalCreateStage;
  result: ExternalCreateSessionResponse | null;
}

interface OperationRow {
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  session_id: string;
  stage: ExternalCreateStage;
  result_json: string | null;
}

function toOperation(row: OperationRow): ExternalCreateOperation {
  return {
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    sessionId: row.session_id,
    stage: row.stage,
    result: row.result_json
      ? externalCreateSessionResponseSchema.parse(JSON.parse(row.result_json))
      : null,
  };
}

/** D1 coordination for retry-safe, multi-stage external session creation. */
export class ExternalSessionCreateOperationStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    sessionId: string;
  }): Promise<ExternalCreateOperation> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO external_session_create_operations
         (user_id, idempotency_key, request_hash, session_id, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?)`
      )
      .bind(input.userId, input.idempotencyKey, input.requestHash, input.sessionId, now, now)
      .run();
    const operation = await this.get(input.userId, input.idempotencyKey);
    if (!operation) throw new Error("Failed to claim external session create operation");
    return operation;
  }

  async get(userId: string, idempotencyKey: string): Promise<ExternalCreateOperation | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, idempotency_key, request_hash, session_id, stage, result_json
         FROM external_session_create_operations WHERE user_id = ? AND idempotency_key = ?`
      )
      .bind(userId, idempotencyKey)
      .first<OperationRow>();
    return row ? toOperation(row) : null;
  }

  async markSessionCreated(operation: ExternalCreateOperation): Promise<ExternalCreateOperation> {
    return this.transition(operation, "reserved", "session_created", null);
  }

  async complete(
    operation: ExternalCreateOperation,
    result: ExternalCreateSessionResponse
  ): Promise<ExternalCreateOperation> {
    return this.transition(operation, "session_created", "completed", result);
  }

  private async transition(
    operation: ExternalCreateOperation,
    expectedStage: ExternalCreateStage,
    nextStage: ExternalCreateStage,
    result: ExternalCreateSessionResponse | null
  ): Promise<ExternalCreateOperation> {
    const write = await this.db
      .prepare(
        `UPDATE external_session_create_operations
         SET stage = ?, result_json = ?, updated_at = ?
         WHERE user_id = ? AND idempotency_key = ? AND request_hash = ? AND stage = ?`
      )
      .bind(
        nextStage,
        result === null ? null : JSON.stringify(result),
        Date.now(),
        operation.userId,
        operation.idempotencyKey,
        operation.requestHash,
        expectedStage
      )
      .run();
    const current = await this.get(operation.userId, operation.idempotencyKey);
    if (!current || current.requestHash !== operation.requestHash) {
      throw new Error("External create operation changed");
    }
    if (write.meta.changes === 1) return current;
    if (current.stage === nextStage || current.stage === "completed") return current;
    throw new Error(
      `Cannot transition external create operation from ${current.stage} to ${nextStage}`
    );
  }
}
