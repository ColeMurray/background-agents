import {
  sandboxIngressEventSchema,
  type SandboxIngressEvent,
} from "@open-inspect/shared/types/sandbox-events";
import { z } from "zod";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { UsageAccountingSnapshot } from "../harness/accounting";
import { piRuntimeUsageSchema } from "../pi/runtime-contract";
import { assertPiDoTablesAsync } from "./schema";

const outboxRowSchema = z.object({
  sequence: z.number().int().positive(),
  display_id: z.string(),
  operation_id: z.string(),
  event_json: z.string(),
});

const MAX_FINALIZATION_TOMBSTONES = 128;

export class PermanentPiProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentPiProjectionError";
  }
}

/** Immutable, operation-scoped delivery log for normalized SessionDO events. */
export class PiProjectionOutbox {
  private initialized = false;

  constructor(
    private readonly sql: SqliteDatabase,
    private readonly deliver: (
      sequence: number,
      displayId: string,
      operationId: string,
      event: SandboxIngressEvent
    ) => Promise<void>,
    private readonly now: () => number = Date.now
  ) {}

  enqueue(
    displayId: string,
    operationId: string,
    event: SandboxIngressEvent,
    createdAt: number,
    sourceId: string | null = null
  ): Promise<number> {
    return this.enqueueCoordinated(displayId, operationId, event, createdAt, sourceId);
  }

  private async enqueueCoordinated(
    displayId: string,
    operationId: string,
    event: SandboxIngressEvent,
    createdAt: number,
    sourceId: string | null
  ): Promise<number> {
    await this.assertTables();
    const eventJson = JSON.stringify(sandboxIngressEventSchema.parse(event));
    if (sourceId === null) {
      const row = await this.sql.get<{ sequence: number }>(
        `INSERT INTO oi_pi_projection_outbox (
             sequence, operation_id, display_id, source_id, event_json, created_at
           ) SELECT COALESCE(MAX(sequence), 0) + 1, ?, ?, NULL, ?, ?
             FROM oi_pi_projection_outbox WHERE operation_id = ? RETURNING sequence`,
        operationId,
        displayId,
        eventJson,
        createdAt,
        operationId
      );
      if (!row) throw new Error("Pi projection outbox insert returned no sequence");
      return row.sequence;
    }
    return this.sql.transaction(async (transaction) => {
      await transaction.run(
        `INSERT INTO oi_pi_projection_outbox (
             sequence, operation_id, display_id, source_id, event_json, created_at
           ) SELECT COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?
             FROM oi_pi_projection_outbox WHERE operation_id = ?
           ON CONFLICT(operation_id, source_id) DO NOTHING`,
        operationId,
        displayId,
        sourceId,
        eventJson,
        createdAt,
        operationId
      );
      const row = await transaction.get<{ sequence: number }>(
        `SELECT sequence FROM oi_pi_projection_outbox
           WHERE operation_id = ? AND source_id = ?`,
        operationId,
        sourceId
      );
      if (!row) throw new Error("Pi projection outbox source insert returned no sequence");
      return row.sequence;
    });
  }

  async pending(operationId: string): Promise<number> {
    await this.assertTables();
    const row = await this.sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM oi_pi_projection_outbox
         WHERE operation_id = ? AND delivered_at IS NULL AND failed_at IS NULL`,
      operationId
    );
    if (!row) throw new Error("Pi projection outbox count returned no row");
    return row.count;
  }

  async isFinalized(operationId: string): Promise<boolean> {
    await this.assertTables();
    return (
      (await this.sql.get(
        "SELECT 1 FROM oi_pi_projection_finalization WHERE operation_id = ?",
        operationId
      )) !== undefined
    );
  }

  async markFinalized(
    operationId: string,
    accounting: UsageAccountingSnapshot,
    capturedAt: number
  ): Promise<void> {
    await this.assertTables();
    await this.sql.run(
      `INSERT INTO oi_pi_projection_finalization
         (operation_id, cost_usd, usage_json, captured_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      operationId,
      accounting.costUsd,
      JSON.stringify(accounting.usage),
      capturedAt
    );
  }

  async finalAccounting(operationId: string): Promise<UsageAccountingSnapshot | null> {
    await this.assertTables();
    const row = await this.sql.get<{ cost_usd?: unknown; usage_json?: unknown }>(
      `SELECT cost_usd, usage_json FROM oi_pi_projection_finalization
          WHERE operation_id = ?`,
      operationId
    );
    if (typeof row?.cost_usd !== "number" || typeof row.usage_json !== "string") return null;
    const usage = piRuntimeUsageSchema.parse(JSON.parse(row.usage_json));
    return { usage, costUsd: row.cost_usd };
  }

  async markResultRejected(operationId: string, error: string): Promise<void> {
    await this.assertTables();
    await this.sql.run(
      `UPDATE oi_pi_projection_finalization SET result_rejection = ?
         WHERE operation_id = ? AND result_rejection IS NULL`,
      error,
      operationId
    );
  }

  async resultRejection(operationId: string): Promise<string | null> {
    await this.assertTables();
    const row = await this.sql.get<{ result_rejection?: unknown }>(
      `SELECT result_rejection FROM oi_pi_projection_finalization
         WHERE operation_id = ?`,
      operationId
    );
    return typeof row?.result_rejection === "string" ? row.result_rejection : null;
  }

  /** The operations whose events have not reached the owning session yet. */
  async undeliveredOperations(): Promise<string[]> {
    await this.assertTables();
    const rows = await this.sql.all<{ operation_id: string }>(
      `SELECT DISTINCT operation_id FROM oi_pi_projection_outbox
         WHERE delivered_at IS NULL AND failed_at IS NULL
         ORDER BY operation_id`
    );
    return rows.map((row) => row.operation_id);
  }

  async drain(operationId: string): Promise<void> {
    await this.assertTables();
    for (;;) {
      const raw = await this.sql.get(
        `SELECT sequence, display_id, operation_id, event_json
           FROM oi_pi_projection_outbox
           WHERE operation_id = ? AND delivered_at IS NULL AND failed_at IS NULL
           ORDER BY sequence ASC LIMIT 1`,
        operationId
      );
      if (!raw) break;
      const row = outboxRowSchema.parse(raw);
      const event = sandboxIngressEventSchema.parse(JSON.parse(row.event_json));
      try {
        await this.deliver(row.sequence, row.display_id, row.operation_id, event);
      } catch (error) {
        if (!(error instanceof PermanentPiProjectionError)) throw error;
        await this.sql.run(
          `UPDATE oi_pi_projection_outbox SET failed_at = ?, failure = ?
             WHERE operation_id = ? AND sequence = ?
               AND delivered_at IS NULL AND failed_at IS NULL`,
          this.now(),
          error.message,
          operationId,
          row.sequence
        );
        throw error;
      }
      await this.sql.run(
        `UPDATE oi_pi_projection_outbox SET delivered_at = ?
           WHERE operation_id = ? AND sequence = ?
             AND delivered_at IS NULL AND failed_at IS NULL`,
        this.now(),
        operationId,
        row.sequence
      );
    }
    const failed = await this.sql.get<{ failure?: unknown }>(
      `SELECT failure FROM oi_pi_projection_outbox
         WHERE operation_id = ? AND failed_at IS NOT NULL ORDER BY sequence ASC LIMIT 1`,
      operationId
    );
    if (typeof failed?.failure === "string") throw new PermanentPiProjectionError(failed.failure);
  }

  async complete(operationId: string): Promise<void> {
    await this.assertTables();
    await this.sql.transaction(async (transaction) => {
      await transaction.run(
        "DELETE FROM oi_pi_projection_outbox WHERE operation_id = ?",
        operationId
      );
      await transaction.run(
        `DELETE FROM oi_pi_projection_finalization
          WHERE operation_id NOT IN (
            SELECT operation_id FROM oi_pi_projection_finalization
            ORDER BY captured_at DESC, operation_id DESC LIMIT ?
          )`,
        MAX_FINALIZATION_TOMBSTONES
      );
    });
  }

  private async assertTables(): Promise<void> {
    if (this.initialized) return;
    // The tables are the Pi Durable Object's tracked migration's work, not
    // this outbox's: a missing table is a deployment that did not migrate.
    await assertPiDoTablesAsync(
      this.sql,
      "oi_pi_projection_outbox",
      "oi_pi_projection_finalization"
    );
    this.initialized = true;
  }
}
