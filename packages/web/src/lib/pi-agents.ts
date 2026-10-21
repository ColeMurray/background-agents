import { z } from "zod";

const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

const agentSchema = z.object({
  conversationId: z.number().int().positive(),
  parent: z
    .object({ conversationId: z.number().int().positive(), entryId: z.number().int().positive() })
    .optional(),
  owner: z
    .object({ conversationId: z.number().int().positive(), taskId: z.number().int().positive() })
    .optional(),
  status: z.enum(["active", "queued", "idle"]),
  queued: z.number().int().nonnegative(),
  tasks: z
    .array(
      z.object({
        id: z.number().int().positive(),
        kind: z.string().max(128),
        status: z.string().max(128),
        phase: z.string().max(128).optional(),
        abortRequested: z.boolean(),
      })
    )
    .max(16),
  usage: z.object({ usage: usageSchema, costUsd: z.number().nonnegative() }),
  lastEntryId: z.number().int().positive().nullable(),
});

export const piAgentsEnvelopeSchema = z.object({
  requestId: z.string().max(128).optional(),
  state: z.literal("completed"),
  result: z.object({ agents: z.array(agentSchema).max(32) }),
});

export type PiAgentsEnvelope = z.infer<typeof piAgentsEnvelopeSchema>;
export type PiAgentSnapshot = PiAgentsEnvelope["result"]["agents"][number];
