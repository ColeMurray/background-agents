import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { HarnessActionCeiling } from "../harness/action-ceiling";

export interface PiTurnAuthority {
  readonly operationId: string;
  readonly deadlineMs: number | undefined;
  readonly remainingActions: number;
}

interface TurnAuthorityRow {
  operation_id: string;
  deadline_ms: number | null;
  remaining_actions: number;
}

function toAuthority(row: TurnAuthorityRow): PiTurnAuthority {
  return {
    operationId: row.operation_id,
    deadlineMs: row.deadline_ms ?? undefined,
    remainingActions: row.remaining_actions,
  };
}

/** Durable per-turn authority coordinated with Pi's shared SQLite queue. */
export class PiTurnAuthorityStore {
  constructor(private readonly database: SqliteDatabase) {}

  async initialize(
    operationId: string,
    deadlineMs: number | undefined,
    actionLimit: number
  ): Promise<PiTurnAuthority> {
    await this.database.run(
      `INSERT INTO oi_pi_turn_authority
         (operation_id, deadline_ms, remaining_actions, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (operation_id) DO NOTHING`,
      operationId,
      deadlineMs ?? null,
      Math.max(0, actionLimit),
      Date.now()
    );
    const authority = await this.get(operationId);
    if (!authority) throw new Error("Pi turn authority was not persisted");
    return authority;
  }

  async get(operationId: string): Promise<PiTurnAuthority | undefined> {
    const row = await this.database.get<TurnAuthorityRow>(
      `SELECT operation_id, deadline_ms, remaining_actions
       FROM oi_pi_turn_authority WHERE operation_id = ?`,
      operationId
    );
    return row ? toAuthority(row) : undefined;
  }

  async consume(operationId: string): Promise<PiTurnAuthority | undefined> {
    const row = await this.database.get<TurnAuthorityRow>(
      `UPDATE oi_pi_turn_authority
       SET remaining_actions = remaining_actions - 1
       WHERE operation_id = ? AND remaining_actions > 0
       RETURNING operation_id, deadline_ms, remaining_actions`,
      operationId
    );
    return row ? toAuthority(row) : undefined;
  }

  async delete(operationId: string): Promise<void> {
    await this.database.run("DELETE FROM oi_pi_turn_authority WHERE operation_id = ?", operationId);
  }
}

/** One in-memory view whose consume is authorized by the durable row. */
export function durableTurnActionCeiling(
  store: PiTurnAuthorityStore,
  authority: PiTurnAuthority
): HarnessActionCeiling {
  let remaining = authority.remainingActions;
  return {
    remaining: () => remaining,
    consume: async () => {
      const consumed = await store.consume(authority.operationId);
      remaining = consumed?.remainingActions ?? 0;
      return consumed !== undefined;
    },
  };
}
