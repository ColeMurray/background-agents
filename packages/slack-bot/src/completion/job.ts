import { z } from "zod";

const slackCompletionContextSchema = z.object({
  repoFullName: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
});

export const slackCompletionJobSchema = z.object({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  source: z.enum(["session", "automation"]),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
  channel: z.string().min(1),
  threadTs: z.string().min(1),
  reactionMessageTs: z.string().optional(),
  context: slackCompletionContextSchema,
  traceId: z.string().optional(),
});

export type SlackCompletionJob = z.infer<typeof slackCompletionJobSchema>;

type SlackCompletionJobInput = Omit<SlackCompletionJob, "version" | "deliveryId">;

export function createSlackCompletionJob(input: SlackCompletionJobInput): SlackCompletionJob {
  return {
    version: 1,
    deliveryId: crypto.randomUUID(),
    ...input,
  };
}
