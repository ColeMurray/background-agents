import { z } from "zod";
import { sandboxGenerationSchema } from "@open-inspect/shared/types/sandbox-events";
import { sandboxPreservationSchema } from "@open-inspect/shared/types/sandbox-preservation";
import type { SqlStorage } from "./sql-storage";
import { SessionStorageIntegrityError } from "./types";

const receiptSchema = z.object({
  kind: z.enum(["snapshot", "retained"]),
  artifactId: z.string().min(1),
  provider: z.string(),
  savedAtMs: z.number(),
  runtimeVersion: z.string().nullable(),
});

const stateSchema = sandboxPreservationSchema
  .extend({
    generation: sandboxGenerationSchema,
    provider: z.string().optional(),
    providerObjectId: z.string().nullable(),
    // Proof about the current source, not the artifact's original source.
    sourceRetired: z.boolean().optional(),
    lifetimeKind: z.enum(["finite", "none", "unknown"]),
    protocolVersion: z.literal(1).optional(),
    generationReady: z.boolean(),
    runtimeReady: z.boolean().optional(),
    checkpointInFlight: z.boolean().optional(),
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
        (state.expiresAtMs === null || state.drainAtMs === null)) ||
      ((state.phase === "saved" || state.phase === "retiring") && !state.receipt) ||
      (["draining", "prepared", "capturing"].includes(state.phase) &&
        (!state.operationId ||
          state.stopByMs === undefined ||
          state.captureByMs === undefined ||
          state.retireByMs === undefined)) ||
      (state.phase === "retiring" && (!state.operationId || state.retireByMs === undefined));
    if (incomplete) context.addIssue({ code: "custom", message: "Incomplete preservation phase" });
  });

export type PreservationRecord = z.infer<typeof stateSchema>;
export type PreservationReceipt = z.infer<typeof receiptSchema>;
export interface PreservationStore {
  read(): PreservationRecord | null;
  write(record: PreservationRecord): void;
}

export class SandboxPreservationRepository implements PreservationStore {
  constructor(private readonly sql: SqlStorage) {}

  read(): PreservationRecord | null {
    const row = this.sql
      .exec("SELECT state FROM sandbox_preservation WHERE singleton = 1")
      .toArray()[0];
    if (!row) return null;
    try {
      const persisted = z.object({ state: z.string() }).parse(row);
      return stateSchema.parse(JSON.parse(persisted.state));
    } catch {
      throw new SessionStorageIntegrityError("Malformed sandbox preservation state");
    }
  }

  write(record: PreservationRecord): void {
    this.sql.exec(
      `INSERT INTO sandbox_preservation (singleton, state) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`,
      JSON.stringify(stateSchema.parse(record))
    );
  }
}
