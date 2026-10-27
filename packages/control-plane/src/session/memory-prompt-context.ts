import { z } from "zod";

/**
 * The session runtime's answer to who a sandbox memory call is serving. `othersPrompted` is
 * relative to the account the caller names, or else to the processing prompt's author.
 */
export const memoryPromptContextResponseSchema = z.object({
  authorUserId: z.string().nullable(),
  othersPrompted: z.boolean(),
  parentSessionId: z.string().nullable(),
});

export type MemoryPromptContextResponse = z.infer<typeof memoryPromptContextResponseSchema>;
