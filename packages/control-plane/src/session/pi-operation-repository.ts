import { z } from "zod";
import type { SqlStorage } from "./sql-storage";

export type PiDispatchState = "dispatching" | "ambiguous" | "admitted" | "stopping" | "settled";
const MAX_SETTLED_PI_OPERATION_TOMBSTONES = 128;

const rowSchema = z.object({
  operation_id: z.string(),
  state: z.enum(["dispatching", "ambiguous", "admitted", "stopping", "settled"]),
  last_projection_sequence: z.number().int().nonnegative(),
});

export interface PiDispatchRecord {
  operationId: string;
  state: PiDispatchState;
  lastProjectionSequence: number;
}

/** SessionDO-owned fence for one Pi operation's dispatch and stop reconciliation. */
export class PiOperationRepository {
  constructor(private readonly sql: SqlStorage) {}

  begin(operationId: string, now: number): boolean {
    const result = this.sql.exec(
      `INSERT INTO pi_operation_dispatch (
         operation_id, state, last_projection_sequence, created_at, updated_at
       ) VALUES (?, 'dispatching', 0, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      operationId,
      now,
      now
    );
    result.toArray();
    return result.rowsWritten === 1;
  }

  get(operationId: string): PiDispatchRecord | null {
    const raw = this.sql
      .exec(
        "SELECT operation_id, state, last_projection_sequence FROM pi_operation_dispatch WHERE operation_id = ?",
        operationId
      )
      .toArray()[0];
    if (!raw) return null;
    const row = rowSchema.parse(raw);
    return {
      operationId: row.operation_id,
      state: row.state,
      lastProjectionSequence: row.last_projection_sequence,
    };
  }

  transition(
    operationId: string,
    expectedStates: readonly PiDispatchState[],
    state: PiDispatchState,
    now: number
  ): boolean {
    if (expectedStates.length === 0) return false;
    const result = this.sql.exec(
      `UPDATE pi_operation_dispatch
       SET state = ?, updated_at = ?
       WHERE operation_id = ? AND state IN (${expectedStates.map(() => "?").join(", ")})`,
      state,
      now,
      operationId,
      ...expectedStates
    );
    result.toArray();
    return result.rowsWritten === 1;
  }

  settle(operationId: string, expectedStates: readonly PiDispatchState[], now: number): boolean {
    const settled = this.transition(operationId, expectedStates, "settled", now);
    if (settled) {
      this.sql.exec(
        `DELETE FROM pi_operation_dispatch
         WHERE state = 'settled' AND operation_id NOT IN (
           SELECT operation_id FROM pi_operation_dispatch WHERE state = 'settled'
           ORDER BY updated_at DESC, operation_id DESC LIMIT ?
         )`,
        MAX_SETTLED_PI_OPERATION_TOMBSTONES
      );
    }
    return settled;
  }

  advanceProjection(
    operationId: string,
    expectedSequence: number,
    sequence: number,
    now: number
  ): boolean {
    const result = this.sql.exec(
      `UPDATE pi_operation_dispatch
       SET last_projection_sequence = ?, updated_at = ?
       WHERE operation_id = ? AND last_projection_sequence = ?`,
      sequence,
      now,
      operationId,
      expectedSequence
    );
    result.toArray();
    return result.rowsWritten === 1;
  }
}
