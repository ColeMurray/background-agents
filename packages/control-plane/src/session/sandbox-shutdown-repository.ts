import { z } from "zod";
import { sandboxGenerationSchema } from "@open-inspect/shared/types/sandbox-events";
import { sandboxShutdownSchema } from "@open-inspect/shared/types/sandbox-shutdown";
import type { SqlStorage } from "./sql-storage";
import { SessionStorageIntegrityError } from "./types";

const receiptSchema = z.object({
  kind: z.enum(["snapshot", "retained"]),
  artifactId: z.string().min(1),
  sourceObjectId: z.string().min(1).optional(),
  provider: z.string(),
  savedAtMs: z.number(),
  runtimeVersion: z.string().nullable(),
});

/**
 * The ordinary checkpoint behind `checkpointInFlight`, which stays the
 * exclusion bit so code that predates this field still holds. Persisted with
 * that flag, before the provider call, so its settle time survives a restart.
 */
const captureOpSchema = z.object({
  id: z.string(),
  kind: z.literal("checkpoint"),
  reason: z.string(),
  /** What a confirmed capture permits, set by the caller rather than inferred later. */
  after: z.enum(["continue", "stop_source"]),
  attempt: z.number().int().min(1),
  /** The deadline handed to the provider. */
  deadlineAtMs: z.number(),
  /** After this, the control plane's request has certainly ended, whatever its answer. */
  settleAtMs: z.number(),
  /** An instance saw the request end without a confirmed answer. */
  uncertainAtMs: z.number().optional(),
  /** Set once when settlement waits for a stale runtime heartbeat to recover. */
  deferredUntilMs: z.number().optional(),
});

const stateSchema = sandboxShutdownSchema
  .extend({
    generation: sandboxGenerationSchema,
    provider: z.string().optional(),
    providerObjectId: z.string().nullable(),
    // Proof about the current source, not the artifact's original source.
    sourceRetired: z.boolean().optional(),
    lifetimeKind: z.enum(["finite", "none", "unknown"]),
    lifetimeSource: z.enum(["provider", "conservative_start_bound"]).optional(),
    protocolVersion: z.literal(1).optional(),
    generationReady: z.boolean(),
    runtimeReady: z.boolean().optional(),
    lifecyclePolicy: z.enum(["confirmed", "legacy"]).optional(),
    restoreInvoked: z.boolean().optional(),
    checkpointInFlight: z.boolean().optional(),
    captureOp: captureOpSchema.optional(),
    /** Provenance for unattended retries, distinct from authenticated recovery eligibility. */
    captureFailure: z.boolean().optional(),
    /** A durably claimed discard; no other recovery may act while it is set. */
    discarding: z.string().optional(),
    operationId: z.string().optional(),
    messageId: z.string().optional(),
    stopByMs: z.number().optional(),
    captureByMs: z.number().optional(),
    retireByMs: z.number().optional(),
    receipt: receiptSchema.optional(),
  })
  .superRefine((state, context) => {
    const incomplete =
      (state.lifetimeKind === "finite" &&
        (state.expiresAtMs === null ||
          (state.lifecyclePolicy !== "legacy" && state.drainAtMs === null))) ||
      ((state.phase === "saved" || state.phase === "restoring" || state.phase === "retiring") &&
        !state.receipt) ||
      (["draining", "prepared", "capturing"].includes(state.phase) &&
        (!state.operationId ||
          state.stopByMs === undefined ||
          state.captureByMs === undefined ||
          state.retireByMs === undefined)) ||
      (state.phase === "retiring" && (!state.operationId || state.retireByMs === undefined));
    if (incomplete) context.addIssue({ code: "custom", message: "Incomplete shutdown phase" });
  });

export type ShutdownRecord = z.infer<typeof stateSchema>;
export type ShutdownRecoveryReceipt = z.infer<typeof receiptSchema>;
export type CaptureOperation = z.infer<typeof captureOpSchema>;
export interface ShutdownStore {
  read(): ShutdownRecord | null;
  write(record: ShutdownRecord): void;
}

export class SandboxShutdownRepository implements ShutdownStore {
  constructor(private readonly sql: SqlStorage) {}

  read(): ShutdownRecord | null {
    const row = this.sql
      .exec("SELECT state FROM sandbox_preservation WHERE singleton = 1")
      .toArray()[0];
    if (!row) return null;
    try {
      const persisted = z.object({ state: z.string() }).parse(row);
      return stateSchema.parse(JSON.parse(persisted.state));
    } catch {
      throw new SessionStorageIntegrityError("Malformed sandbox graceful shutdown state");
    }
  }

  write(record: ShutdownRecord): void {
    this.sql.exec(
      `INSERT INTO sandbox_preservation (singleton, state) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`,
      JSON.stringify(stateSchema.parse(record))
    );
  }
}
