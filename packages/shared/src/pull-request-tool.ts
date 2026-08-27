import { z } from "zod";

const pullRequestCreatedOrUpdatedSchema = z.object({
  kind: z.enum(["created", "updated"]),
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  state: z.enum(["open", "draft"]).default("open"),
  headBranch: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  agentMessage: z.string(),
});

export const createPullRequestToolEnvelopeSchema = z.discriminatedUnion("kind", [
  pullRequestCreatedOrUpdatedSchema,
  z.object({
    kind: z.literal("manual"),
    createPrUrl: z.string().min(1),
    agentMessage: z.string(),
  }),
  z.object({
    kind: z.literal("failure"),
    message: z.string().min(1),
    agentMessage: z.string(),
  }),
]);

export type CreatePullRequestToolEnvelope = z.infer<typeof createPullRequestToolEnvelopeSchema>;
