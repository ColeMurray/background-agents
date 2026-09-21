import { z } from "zod";
import { sandboxGenerationSchema } from "@open-inspect/shared/types/sandbox-events";
import { sandboxShutdownSchema } from "@open-inspect/shared/types/sandbox-shutdown";
import type { SqlStorage } from "./sql-storage";
import { SessionStorageIntegrityError } from "./types";

const receiptSchema = z.object({
  kind: z.enum(["snapshot", "retained"]),
  artifactId: z.string().min(1),
  provider: z.string(),
  savedAtMs: z.number(),
  runtimeVersion: z.string().nullable(),
});

const checkpointIdentity = z.object({
  version: z.literal(1),
  operationId: z.string().min(1),
  generation: sandboxGenerationSchema,
  provider: z.string().min(1),
  providerObjectId: z.string().min(1),
  runtimeVersion: z.string().nullable(),
  reason: z.string().min(1),
  startedAtMs: z.number().finite(),
  deadlineAtMs: z.number().finite(),
  nonDestructive: z.literal(true),
});

const checkpointSchema = z.discriminatedUnion("phase", [
  checkpointIdentity.extend({ phase: z.literal("capturing") }),
  checkpointIdentity.extend({ phase: z.literal("unknown"), error: z.string().min(1) }),
  checkpointIdentity.extend({
    phase: z.literal("completed"),
    imageId: z.string().min(1),
    savedAtMs: z.number().finite(),
  }),
]);
export type CheckpointOperation = z.infer<typeof checkpointSchema>;

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
    // Retained only to fail closed on records written by the pre-operation implementation.
    checkpointInFlight: z.boolean().optional(),
    checkpoint: checkpointSchema.optional(),
    operationId: z.string().optional(),
    messageId: z.string().optional(),
    waitByMs: z.number().finite().optional(),
    stopByMs: z.number().optional(),
    captureByMs: z.number().optional(),
    retireByMs: z.number().optional(),
    receipt: receiptSchema.optional(),
  })
  .superRefine((state, context) => {
    const checkpoint = state.checkpoint;
    if (
      checkpoint &&
      (checkpoint.deadlineAtMs <= checkpoint.startedAtMs ||
        checkpoint.generation.sandboxId !== state.generation.sandboxId ||
        checkpoint.generation.createdAt !== state.generation.createdAt ||
        checkpoint.provider !== state.provider ||
        checkpoint.providerObjectId !== state.providerObjectId)
    )
      context.addIssue({ code: "custom", message: "Invalid checkpoint ownership" });
    const incomplete =
      (state.phase === "waiting_for_checkpoint" &&
        (!state.operationId || state.waitByMs === undefined || state.retireByMs === undefined)) ||
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
