import { z } from "zod";

export const MAX_SANDBOX_COMMAND_TIMEOUT_MS = 60 * 60 * 1_000;
export const MAX_SANDBOX_COMMAND_ARGV_ITEMS = 256;
export const MAX_SANDBOX_COMMAND_ARG_BYTES = 32 * 1024;
export const MAX_SANDBOX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export const sandboxRuntimeModeSchema = z.enum(["agent", "execution"]).default("agent");
export type SandboxRuntimeMode = z.infer<typeof sandboxRuntimeModeSchema>;

export const sandboxCommandPurposeSchema = z.enum(["shell", "build", "test"]);
export type SandboxCommandPurpose = z.infer<typeof sandboxCommandPurposeSchema>;

const commandIdSchema = z.string().trim().min(1).max(128);
const workspacePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      (path === "/workspace" || path.startsWith("/workspace/")) && !path.split("/").includes(".."),
    "cwd must stay inside /workspace"
  );

const commandExecuteSchema = z
  .object({
    type: z.literal("command_execute"),
    commandId: commandIdSchema,
    purpose: sandboxCommandPurposeSchema,
    argv: z
      .array(z.string().min(1).max(MAX_SANDBOX_COMMAND_ARG_BYTES))
      .min(1)
      .max(MAX_SANDBOX_COMMAND_ARGV_ITEMS),
    cwd: workspacePathSchema.optional(),
    timeoutMs: z.number().int().positive().max(MAX_SANDBOX_COMMAND_TIMEOUT_MS).optional(),
  })
  .strict();

const commandCancelSchema = z
  .object({
    type: z.literal("command_cancel"),
    commandId: commandIdSchema,
  })
  .strict();

const commandReplaySchema = z
  .object({
    type: z.literal("command_replay"),
    commandId: commandIdSchema,
    /** -1 asks for the complete output when no sequence has been persisted yet. */
    afterSequence: z.number().int().min(-1),
  })
  .strict();

/** Commands sent by SessionDO to an execution-only sandbox bridge. */
export const sandboxExecutionCommandSchema = z.discriminatedUnion("type", [
  commandExecuteSchema,
  commandCancelSchema,
  commandReplaySchema,
]);
export type SandboxExecutionCommand = z.infer<typeof sandboxExecutionCommandSchema>;

const executionEventBaseSchema = z.object({
  commandId: commandIdSchema,
  sandboxId: z.string().min(1),
  timestamp: z.number(),
  ackId: z.string().min(1).optional(),
});

export const sandboxExecutionEventSchemas = [
  executionEventBaseSchema.extend({
    type: z.literal("command_started"),
  }),
  executionEventBaseSchema.extend({
    type: z.literal("command_output"),
    sequence: z.number().int().nonnegative(),
    stream: z.enum(["stdout", "stderr"]),
    data: z.string().max(MAX_SANDBOX_COMMAND_OUTPUT_BYTES),
  }),
  executionEventBaseSchema.extend({
    type: z.literal("command_completed"),
    outcome: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    /** -1 when the process emitted no stdout or stderr chunks. */
    lastSequence: z.number().int().min(-1),
    error: z.string().max(4096).optional(),
  }),
] as const;

/** Events emitted by an execution-only sandbox bridge. */
export const sandboxExecutionEventSchema = z.discriminatedUnion(
  "type",
  sandboxExecutionEventSchemas
);
export type SandboxExecutionEvent = z.infer<typeof sandboxExecutionEventSchema>;
