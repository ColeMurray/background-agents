import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import type { SqlStorage, TransactionSync } from "../session/sql-storage";
import type { SandboxProvider } from "./provider";
import { z } from "zod";

const ALLOCATION_RECOVERY_RETRY_MS = 30_000;
const MAX_ALLOCATION_RECOVERY_RETRY_MS = 5 * 60_000;
const ALLOCATION_RECOVERY_BATCH_SIZE = 25;

export interface AllocationIntent {
  allocation_name: string;
  session_id: string;
  sandbox_id: string;
  generation_created_at: number;
  auth_token_hash: string;
  provider_object_id: string | null;
  cleanup_required: 0 | 1;
  recovery_attempts: number;
  next_attempt_at: number;
  created_at: number;
}

const allocationIntentSchema = z.object({
  allocation_name: z.string().min(1),
  session_id: z.string().min(1),
  sandbox_id: z.string().min(1),
  generation_created_at: z.number(),
  auth_token_hash: z.string().min(1),
  provider_object_id: z.string().nullable(),
  cleanup_required: z.union([z.literal(0), z.literal(1)]),
  recovery_attempts: z.number().int().nonnegative(),
  next_attempt_at: z.number(),
  created_at: z.number(),
});

export class SandboxAllocationCoordinator {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: TransactionSync,
    private readonly provider: SandboxProvider,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly log: Logger
  ) {}

  async reserve(input: {
    allocationName: string;
    sessionId: string;
    sandboxId: string;
    generationCreatedAt: number;
    authTokenHash: string;
  }): Promise<void> {
    const deadline = Date.now() + ALLOCATION_RECOVERY_RETRY_MS;
    this.transaction(() => {
      const inserted = this.sql.exec(
        `INSERT INTO sandbox_allocation_intents
         (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
          provider_object_id, cleanup_required, recovery_attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, ?)
         ON CONFLICT(allocation_name) DO NOTHING
         RETURNING allocation_name`,
        input.allocationName,
        input.sessionId,
        input.sandboxId,
        input.generationCreatedAt,
        input.authTokenHash,
        Date.now()
      );
      if (inserted.toArray().length !== 1) {
        throw new Error("Sandbox allocation name collision");
      }
      this.persistRecoveryDeadline(deadline);
    });
    await this.alarmScheduler.schedule(deadline);
  }

  async acceptProviderResult(intent: AllocationIntent, providerObjectId: string): Promise<boolean> {
    const outcome = this.transaction<"bound" | "same" | "settled" | "cleanup">(() => {
      const currentIntent = this.readExactIntent(intent);
      if (!currentIntent) {
        return this.currentAuthorityHasProvider(intent, providerObjectId) ? "same" : "settled";
      }
      if (currentIntent.cleanup_required) return "settled";
      this.sql.exec(
        `UPDATE sandbox_allocation_intents SET provider_object_id = ?
         WHERE allocation_name = ? AND sandbox_id = ? AND generation_created_at = ?`,
        providerObjectId,
        intent.allocation_name,
        intent.sandbox_id,
        intent.generation_created_at
      );
      const update = this.sql.exec(
        `UPDATE sandbox SET modal_object_id = ?
         WHERE modal_sandbox_id = ? AND created_at = ? AND auth_token_hash = ?
           AND fenced = 0
           AND status IN ('spawning', 'connecting', 'warming', 'ready', 'busy', 'failed')
           AND EXISTS (SELECT 1 FROM session WHERE status NOT IN ('cancelled', 'archived'))
         RETURNING modal_sandbox_id`,
        providerObjectId,
        intent.sandbox_id,
        intent.generation_created_at,
        intent.auth_token_hash
      );
      if (update.toArray().length !== 1) {
        // Archive does not broadly stop healthy sandboxes, but an exact
        // in-flight generation must lose callback/socket authority before
        // cleanup yields. This cannot touch a replacement or ready/busy VM.
        this.sql.exec(
          `UPDATE sandbox SET auth_token_hash = '', auth_token = NULL,
             active_socket_id = '', fenced = 1, status = 'stopped'
           WHERE modal_sandbox_id = ? AND created_at = ? AND auth_token_hash = ?
             AND status IN ('spawning', 'connecting', 'warming', 'failed')
             AND EXISTS (SELECT 1 FROM session WHERE status IN ('cancelled', 'archived'))`,
          intent.sandbox_id,
          intent.generation_created_at,
          intent.auth_token_hash
        );
        this.sql.exec(
          `UPDATE sandbox_allocation_intents
           SET provider_object_id = ?, cleanup_required = 1
           WHERE allocation_name = ? AND sandbox_id = ? AND generation_created_at = ?
             AND auth_token_hash = ?`,
          providerObjectId,
          intent.allocation_name,
          intent.sandbox_id,
          intent.generation_created_at,
          intent.auth_token_hash
        );
        return "cleanup";
      }
      this.deleteExact(intent);
      return "bound";
    });
    if (outcome === "cleanup" && this.exactIntentExists(intent)) {
      await this.cleanup(intent, providerObjectId);
    }
    return outcome === "bound" || outcome === "same";
  }

  async recover(): Promise<boolean> {
    const intents = this.listDue();
    for (const intent of intents) {
      try {
        const providerObjectId = intent.cleanup_required
          ? intent.provider_object_id
          : (intent.provider_object_id ??
            (await this.provider.reconcileAllocation?.({
              allocationName: intent.allocation_name,
              sessionId: intent.session_id,
              sandboxId: intent.sandbox_id,
            })));
        if (!providerObjectId) {
          this.defer(intent);
          continue;
        }
        if (intent.cleanup_required) await this.cleanup(intent, providerObjectId);
        else await this.acceptProviderResult(intent, providerObjectId);
      } catch (error) {
        this.log.warn("sandbox.allocation_recovery_retry", {
          allocation_name: intent.allocation_name,
          error: error instanceof Error ? error.message : String(error),
        });
        this.defer(intent);
      }
    }
    const remaining = this.intentCount() > 0;
    if (remaining) await this.alarmScheduler.schedule(Date.now() + ALLOCATION_RECOVERY_RETRY_MS);
    return remaining;
  }

  async rejectProviderResult(intent: AllocationIntent, providerObjectId: string): Promise<void> {
    if (!this.exactIntentExists(intent)) return;
    this.sql.exec(
      `UPDATE sandbox_allocation_intents
       SET provider_object_id = ?, cleanup_required = 1
       WHERE allocation_name = ? AND sandbox_id = ? AND generation_created_at = ?
         AND auth_token_hash = ?`,
      providerObjectId,
      intent.allocation_name,
      intent.sandbox_id,
      intent.generation_created_at,
      intent.auth_token_hash
    );
    await this.cleanup(intent, providerObjectId);
  }

  find(allocationName: string): AllocationIntent | null {
    const [row] = this.sql
      .exec(`SELECT * FROM sandbox_allocation_intents WHERE allocation_name = ?`, allocationName)
      .toArray();
    if (!row) return null;
    const parsed = allocationIntentSchema.safeParse(row);
    if (parsed.success) return parsed.data;
    this.log.error("sandbox.allocation_intent_malformed", { issues: parsed.error.issues });
    return null;
  }

  private async cleanup(intent: AllocationIntent, providerObjectId: string): Promise<void> {
    if (!this.provider.terminateAllocation) {
      throw new Error("Provider cannot terminate a durable allocation intent");
    }
    await this.provider.terminateAllocation({
      allocationName: intent.allocation_name,
      providerObjectId,
      sessionId: intent.session_id,
      sandboxId: intent.sandbox_id,
    });
    this.transaction(() => this.deleteExact(intent));
  }

  private listDue(includeDeferred = false): AllocationIntent[] {
    const rows = this.sql
      .exec(
        `SELECT rowid AS intent_rowid, * FROM sandbox_allocation_intents
         ${includeDeferred ? "" : "WHERE next_attempt_at <= ?"}
         ORDER BY next_attempt_at, created_at LIMIT ?`,
        ...(includeDeferred
          ? [ALLOCATION_RECOVERY_BATCH_SIZE]
          : [Date.now(), ALLOCATION_RECOVERY_BATCH_SIZE])
      )
      .toArray();
    const valid: AllocationIntent[] = [];
    for (const row of rows) {
      const parsed = allocationIntentSchema.safeParse(row);
      if (parsed.success) valid.push(parsed.data);
      else {
        this.log.error("sandbox.allocation_intent_malformed", { issues: parsed.error.issues });
        const rowid = (row as { intent_rowid?: unknown }).intent_rowid;
        if (typeof rowid === "number") {
          this.sql.exec(
            `UPDATE sandbox_allocation_intents
             SET recovery_attempts = recovery_attempts + 1, next_attempt_at = ? WHERE rowid = ?`,
            Date.now() + MAX_ALLOCATION_RECOVERY_RETRY_MS,
            rowid
          );
        }
      }
    }
    return valid;
  }

  private intentCount(): number {
    const [row] = this.sql
      .exec(`SELECT COUNT(*) AS count FROM sandbox_allocation_intents`)
      .toArray();
    return Number((row as { count?: number })?.count ?? 0);
  }

  private defer(intent: AllocationIntent): void {
    const attempts = intent.recovery_attempts + 1;
    const delay = Math.min(
      ALLOCATION_RECOVERY_RETRY_MS * 2 ** Math.min(attempts - 1, 4),
      MAX_ALLOCATION_RECOVERY_RETRY_MS
    );
    this.sql.exec(
      `UPDATE sandbox_allocation_intents SET recovery_attempts = ?, next_attempt_at = ?
       WHERE allocation_name = ? AND sandbox_id = ? AND generation_created_at = ?
         AND auth_token_hash = ?`,
      attempts,
      Date.now() + delay,
      intent.allocation_name,
      intent.sandbox_id,
      intent.generation_created_at,
      intent.auth_token_hash
    );
  }

  private deleteExact(intent: AllocationIntent): void {
    this.sql.exec(
      `DELETE FROM sandbox_allocation_intents
       WHERE allocation_name = ? AND sandbox_id = ? AND generation_created_at = ?
         AND auth_token_hash = ?`,
      intent.allocation_name,
      intent.sandbox_id,
      intent.generation_created_at,
      intent.auth_token_hash
    );
  }

  private exactIntentExists(intent: AllocationIntent): boolean {
    return this.readExactIntent(intent) !== null;
  }

  private readExactIntent(intent: AllocationIntent): AllocationIntent | null {
    const [row] = this.sql
      .exec(
        `SELECT * FROM sandbox_allocation_intents
         WHERE allocation_name = ? AND sandbox_id = ? AND generation_created_at = ?
           AND auth_token_hash = ?`,
        intent.allocation_name,
        intent.sandbox_id,
        intent.generation_created_at,
        intent.auth_token_hash
      )
      .toArray();
    if (!row) return null;
    const parsed = allocationIntentSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }

  private currentAuthorityHasProvider(intent: AllocationIntent, providerObjectId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 AS present FROM sandbox
           WHERE modal_sandbox_id = ? AND created_at = ? AND auth_token_hash = ?
             AND modal_object_id = ? AND fenced = 0
             AND status IN ('spawning', 'connecting', 'warming', 'ready', 'busy', 'failed')
             AND EXISTS (SELECT 1 FROM session WHERE status NOT IN ('cancelled', 'archived'))`,
          intent.sandbox_id,
          intent.generation_created_at,
          intent.auth_token_hash,
          providerObjectId
        )
        .toArray().length === 1
    );
  }

  private persistRecoveryDeadline(deadline: number): void {
    this.sql.exec(
      `INSERT INTO session_alarm_state (singleton, pending_deadline, cancelled) VALUES (1, ?, 0)
       ON CONFLICT(singleton) DO UPDATE SET
         pending_deadline = CASE
           WHEN session_alarm_state.pending_deadline IS NULL THEN excluded.pending_deadline
           ELSE MIN(session_alarm_state.pending_deadline, excluded.pending_deadline)
         END,
         cancelled = 0`,
      deadline
    );
  }
}
