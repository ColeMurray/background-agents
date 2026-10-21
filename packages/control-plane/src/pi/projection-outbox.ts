import {
  sandboxIngressEventSchema,
  type SandboxIngressEvent,
} from "@open-inspect/shared/types/sandbox-events";
import { z } from "zod";
import type { SqlStorage } from "../session/sql-storage";
import type { UsageAccountingSnapshot } from "../harness/accounting";
import { piRuntimeUsageSchema } from "../pi/runtime-contract";
import { assertPiDoTables } from "./schema";

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
    private readonly sql: SqlStorage,
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
  ): number {
    this.assertTables();
    const eventJson = JSON.stringify(sandboxIngressEventSchema.parse(event));
    if (sourceId === null) {
      const row = this.sql
        .exec(
          `INSERT INTO oi_pi_projection_outbox (
             sequence, operation_id, display_id, source_id, event_json, created_at
           ) SELECT COALESCE(MAX(sequence), 0) + 1, ?, ?, NULL, ?, ?
             FROM oi_pi_projection_outbox WHERE operation_id = ? RETURNING sequence`,
          operationId,
          displayId,
          eventJson,
          createdAt,
          operationId
        )
        .one() as { sequence: number };
      return row.sequence;
    }
    this.sql
      .exec(
        `INSERT OR IGNORE INTO oi_pi_projection_outbox (
           sequence, operation_id, display_id, source_id, event_json, created_at
         ) SELECT COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?
           FROM oi_pi_projection_outbox WHERE operation_id = ?`,
        operationId,
        displayId,
        sourceId,
        eventJson,
        createdAt,
        operationId
      )
      .toArray();
    const row = this.sql
      .exec(
        `SELECT sequence FROM oi_pi_projection_outbox
         WHERE operation_id = ? AND source_id = ?`,
        operationId,
        sourceId
      )
      .one() as { sequence: number };
    return row.sequence;
  }

  pending(operationId: string): number {
    this.assertTables();
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS count FROM oi_pi_projection_outbox
         WHERE operation_id = ? AND delivered_at IS NULL AND failed_at IS NULL`,
        operationId
      )
      .one() as { count: number };
    return row.count;
  }

  isFinalized(operationId: string): boolean {
    this.assertTables();
    return (
      this.sql
        .exec("SELECT 1 FROM oi_pi_projection_finalization WHERE operation_id = ?", operationId)
        .toArray().length > 0
    );
  }

  markFinalized(
    operationId: string,
    accounting: UsageAccountingSnapshot,
    capturedAt: number
  ): void {
    this.assertTables();
    this.sql
      .exec(
        `INSERT OR IGNORE INTO oi_pi_projection_finalization
         (operation_id, cost_usd, usage_json, captured_at) VALUES (?, ?, ?, ?)`,
        operationId,
        accounting.costUsd,
        JSON.stringify(accounting.usage),
        capturedAt
      )
      .toArray();
  }

  finalAccounting(operationId: string): UsageAccountingSnapshot | null {
    this.assertTables();
    const row = this.sql
      .exec(
        `SELECT cost_usd, usage_json FROM oi_pi_projection_finalization
         WHERE operation_id = ?`,
        operationId
      )
      .toArray()[0] as { cost_usd?: unknown; usage_json?: unknown } | undefined;
    if (typeof row?.cost_usd !== "number" || typeof row.usage_json !== "string") return null;
    const usage = piRuntimeUsageSchema.parse(JSON.parse(row.usage_json));
    return { usage, costUsd: row.cost_usd };
  }

  markResultRejected(operationId: string, error: string): void {
    this.assertTables();
    this.sql
      .exec(
        `UPDATE oi_pi_projection_finalization SET result_rejection = ?
         WHERE operation_id = ? AND result_rejection IS NULL`,
        error,
        operationId
      )
      .toArray();
  }

  resultRejection(operationId: string): string | null {
    this.assertTables();
    const row = this.sql
      .exec(
        `SELECT result_rejection FROM oi_pi_projection_finalization
         WHERE operation_id = ?`,
        operationId
      )
      .toArray()[0] as { result_rejection?: unknown } | undefined;
    return typeof row?.result_rejection === "string" ? row.result_rejection : null;
  }

  /** The operations whose events have not reached the owning session yet. */
  undeliveredOperations(): string[] {
    this.assertTables();
    const rows = this.sql
      .exec(
        `SELECT DISTINCT operation_id FROM oi_pi_projection_outbox
         WHERE delivered_at IS NULL AND failed_at IS NULL
         ORDER BY operation_id`
      )
      .toArray() as Array<{ operation_id: string }>;
    return rows.map((row) => row.operation_id);
  }

  async drain(operationId: string): Promise<void> {
    this.assertTables();
    for (;;) {
      const raw = this.sql
        .exec(
          `SELECT sequence, display_id, operation_id, event_json
           FROM oi_pi_projection_outbox
           WHERE operation_id = ? AND delivered_at IS NULL AND failed_at IS NULL
           ORDER BY sequence ASC LIMIT 1`,
          operationId
        )
        .toArray()[0];
      if (!raw) break;
      const row = outboxRowSchema.parse(raw);
      const event = sandboxIngressEventSchema.parse(JSON.parse(row.event_json));
      try {
        await this.deliver(row.sequence, row.display_id, row.operation_id, event);
      } catch (error) {
        if (!(error instanceof PermanentPiProjectionError)) throw error;
        this.sql
          .exec(
            `UPDATE oi_pi_projection_outbox SET failed_at = ?, failure = ?
             WHERE operation_id = ? AND sequence = ?
               AND delivered_at IS NULL AND failed_at IS NULL`,
            this.now(),
            error.message,
            operationId,
            row.sequence
          )
          .toArray();
        throw error;
      }
      this.sql
        .exec(
          `UPDATE oi_pi_projection_outbox SET delivered_at = ?
           WHERE operation_id = ? AND sequence = ?
             AND delivered_at IS NULL AND failed_at IS NULL`,
          this.now(),
          operationId,
          row.sequence
        )
        .toArray();
    }
    const failed = this.sql
      .exec(
        `SELECT failure FROM oi_pi_projection_outbox
         WHERE operation_id = ? AND failed_at IS NOT NULL ORDER BY sequence ASC LIMIT 1`,
        operationId
      )
      .toArray()[0] as { failure?: unknown } | undefined;
    if (typeof failed?.failure === "string") throw new PermanentPiProjectionError(failed.failure);
  }

  complete(operationId: string): void {
    this.assertTables();
    this.sql
      .exec("DELETE FROM oi_pi_projection_outbox WHERE operation_id = ?", operationId)
      .toArray();
    this.sql
      .exec(
        `DELETE FROM oi_pi_projection_finalization
         WHERE operation_id NOT IN (
           SELECT operation_id FROM oi_pi_projection_finalization
           ORDER BY captured_at DESC, operation_id DESC LIMIT ?
         )`,
        MAX_FINALIZATION_TOMBSTONES
      )
      .toArray();
  }

  private assertTables(): void {
    if (this.initialized) return;
    // The tables are the Pi Durable Object's tracked migration's work, not
    // this outbox's: a missing table is a deployment that did not migrate.
    assertPiDoTables(this.sql, "oi_pi_projection_outbox", "oi_pi_projection_finalization");
    this.initialized = true;
  }
}
