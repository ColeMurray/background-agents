import { z } from "zod";

/** Durable user-visible outcome, also included in reconnect snapshots. */
export const sandboxPreservationSchema = z.object({
  phase: z.enum([
    "running",
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
});

export type SandboxPreservationState = z.infer<typeof sandboxPreservationSchema>;
