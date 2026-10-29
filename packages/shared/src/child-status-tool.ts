import { z } from "zod";

// Deliberately contains display fields only, never artifact retrieval metadata.
const childStatusSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  status: z.string().min(1),
  repoOwner: z.string().nullable().optional(),
  repoName: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  model: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export const childStatusToolEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("list"),
    children: z.array(childStatusSessionSchema),
    agentMessage: z.string(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("detail"),
    session: childStatusSessionSchema,
    hasUnfinishedPrompt: z.boolean().optional(),
    finalResponse: z
      .object({
        success: z.boolean(),
        textContent: z.string(),
        error: z.string().optional(),
        eventCount: z.number().int().nonnegative().optional(),
        eventLimitReached: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    agentMessage: z.string(),
  }),
]);

export type ChildStatusToolEnvelope = z.infer<typeof childStatusToolEnvelopeSchema>;
