import type { SqlStorage } from "./sql-storage";

export interface PiControlReceipt {
  requestId: string;
  requestHash: string;
  action: string;
  actorId: string;
  source: string;
  state: "processing" | "accepted" | "completed" | "failed" | "indeterminate";
  conversationId: string | null;
  operationId: string | null;
  submissionId: number | null;
  taskId: number | null;
  result: unknown;
  errorCode: string | null;
}
export class PiControlRepository {
  constructor(private readonly sql: SqlStorage) {}
  get(requestId: string): PiControlReceipt | null {
    const row = this.sql
      .exec("SELECT * FROM pi_control_receipts WHERE request_id=?", requestId)
      .toArray()[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      requestHash: String(row.request_hash),
      action: String(row.action),
      actorId: String(row.actor_id),
      source: String(row.source),
      state: row.state as PiControlReceipt["state"],
      conversationId: row.conversation_id == null ? null : String(row.conversation_id),
      operationId: row.operation_id == null ? null : String(row.operation_id),
      submissionId: row.submission_id == null ? null : Number(row.submission_id),
      taskId: row.task_id == null ? null : Number(row.task_id),
      result: row.result_json == null ? undefined : JSON.parse(String(row.result_json)),
      errorCode: row.error_code == null ? null : String(row.error_code),
    };
  }
  admit(
    input: {
      requestId: string;
      requestHash: string;
      action: string;
      actorId: string;
      source: string;
      conversationId?: string | number;
      operationId?: string;
      submissionId?: number;
      taskId?: number;
    },
    now: number
  ): { receipt: PiControlReceipt; created: boolean } {
    const prior = this.get(input.requestId);
    if (prior) {
      if (
        prior.action !== input.action ||
        prior.actorId !== input.actorId ||
        prior.source !== input.source ||
        prior.requestHash !== input.requestHash
      )
        throw new Error("Pi control request id conflict");
      return { receipt: prior, created: false };
    }
    this.sql.exec(
      "INSERT OR IGNORE INTO pi_control_receipts(request_id,request_hash,action,actor_id,source,state,conversation_id,operation_id,submission_id,task_id,created_at,updated_at) VALUES(?,?,?,?,?,'processing',?,?,?,?,?,?)",
      input.requestId,
      input.requestHash,
      input.action,
      input.actorId,
      input.source,
      input.conversationId ?? null,
      input.operationId ?? null,
      input.submissionId ?? null,
      input.taskId ?? null,
      now,
      now
    );
    const receipt = this.get(input.requestId);
    if (!receipt) throw new Error("Pi control receipt missing after admission");
    return { receipt, created: true };
  }
  settle(
    requestId: string,
    state: "accepted" | "completed" | "failed" | "indeterminate",
    result: unknown,
    errorCode: string | undefined,
    now: number
  ): PiControlReceipt | null {
    const resultJson = result === undefined ? null : JSON.stringify(result);
    if (resultJson && new TextEncoder().encode(resultJson).byteLength > 65_536)
      throw new Error("Pi control result is too large");
    this.sql.exec(
      `UPDATE pi_control_receipts
       SET state=?,result_json=?,error_code=?,updated_at=?,terminal_at=?
       WHERE request_id=? AND state='processing'`,
      state,
      resultJson,
      errorCode ?? null,
      now,
      state === "accepted" ? null : now,
      requestId
    );
    return this.get(requestId);
  }
  isActiveOperation(requestId: string): boolean {
    const row = this.sql
      .exec(
        `SELECT 1 AS active FROM pi_control_receipts
         WHERE request_id=?
           AND action IN ('submit','send','steer','follow_up','compact')
           AND state IN ('processing','accepted','indeterminate')`,
        requestId
      )
      .toArray()[0];
    return row !== undefined;
  }
  complete(
    requestId: string,
    state: "completed" | "failed",
    errorCode: string | undefined,
    now: number
  ): { receipt: PiControlReceipt | null; changed: boolean } {
    const result = this.sql.exec(
      `UPDATE pi_control_receipts
       SET state=?,error_code=?,updated_at=?,terminal_at=?
       WHERE request_id=? AND state IN ('processing','accepted','indeterminate')`,
      state,
      errorCode ?? null,
      now,
      now,
      requestId
    );
    return { receipt: this.get(requestId), changed: (result.rowsWritten ?? 0) > 0 };
  }
  prune(limit = 128): void {
    this.sql.exec(
      `DELETE FROM pi_control_receipts
       WHERE terminal_at IS NOT NULL
         AND request_id NOT IN (
           SELECT request_id FROM pi_control_receipts
           WHERE terminal_at IS NOT NULL
           ORDER BY terminal_at DESC, request_id DESC
           LIMIT ?
         )`,
      limit
    );
  }
}
