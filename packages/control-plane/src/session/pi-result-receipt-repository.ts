import type { SqlStorage } from "./sql-storage";

export class PiResultReceiptRepository {
  constructor(private readonly sql: SqlStorage) {}

  has(operationId: string): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM pi_result_receipts WHERE operation_id = ?", operationId)
        .toArray().length > 0
    );
  }

  record(operationId: string, projectedAt: number): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO pi_result_receipts (operation_id, projected_at) VALUES (?, ?)",
      operationId,
      projectedAt
    );
  }
}
