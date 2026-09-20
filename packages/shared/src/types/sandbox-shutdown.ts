import { z } from "zod";

export const shutdownRecoveryActionSchema = z.enum(["retry", "restore_saved"]);
export type ShutdownRecoveryAction = z.infer<typeof shutdownRecoveryActionSchema>;

/** Durable user-visible outcome, also included in reconnect snapshots. */
export const sandboxShutdownSchema = z.object({
  phase: z.enum([
    "running",
    "restoring",
    "draining",
    "prepared",
    "capturing",
    "retiring",
    "saved",
    "failed",
    "unknown",
  ]),
  reason: z.string().optional(),
  expiresAtMs: z.number().nullable(),
  drainAtMs: z.number().nullable(),
  savedAtMs: z.number().optional(),
  error: z.string().optional(),
  hasRecoveryPoint: z.boolean().optional(),
  /** Server-authoritative actions currently safe for this exact sandbox generation. */
  availableRecoveryActions: z.array(shutdownRecoveryActionSchema).optional(),
  /** Queued work requires an explicit user resume after an active prompt was interrupted. */
  continuationPaused: z.boolean().optional(),
});

export type SandboxShutdownState = z.infer<typeof sandboxShutdownSchema>;
