import type { SqlStorage } from "./sql-storage";

const MAX_HARNESS_RESULT_RECEIPTS = 128;

export class HarnessResultReceiptRepository {
  constructor(private readonly sql: SqlStorage) {}

  has(operationId: string): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM harness_result_receipts WHERE operation_id = ?", operationId)
        .toArray().length > 0
    );
  }

  record(operationId: string, projectedAt: number): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO harness_result_receipts (operation_id, projected_at) VALUES (?, ?)",
      operationId,
      projectedAt
    );
    this.sql.exec(
      `DELETE FROM harness_result_receipts WHERE operation_id NOT IN (
         SELECT operation_id FROM harness_result_receipts
         ORDER BY projected_at DESC, operation_id DESC LIMIT ?
       )`,
      MAX_HARNESS_RESULT_RECEIPTS
    );
  }
}
