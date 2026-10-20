import { z } from "zod";

export const sessionExecutionSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  purpose: z.enum(["shell", "build", "test"]),
  state: z.enum([
    "queued",
    "dispatched",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "indeterminate",
  ]),
  actor: z.object({ kind: z.enum(["user", "service"]), id: z.string() }).nullable(),
  approvalRevision: z.number().nullable(),
  outputBytes: z.number(),
  outputTruncated: z.boolean(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  replayGap: z.boolean(),
});

export const sessionExecutionsEnvelopeSchema = z.object({
  commands: z.array(sessionExecutionSchema),
});

export const sessionExecutionOutputSchema = z.object({
  chunks: z.array(
    z.object({
      sequence: z.number(),
      stream: z.enum(["stdout", "stderr"]),
      data: z.string(),
      createdAt: z.number(),
    })
  ),
  nextSequence: z.number().nullable(),
});

export type SessionExecution = z.infer<typeof sessionExecutionSchema>;
