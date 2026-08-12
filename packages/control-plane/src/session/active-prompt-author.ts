import { z } from "zod";

/** Public identity needed to attribute work initiated by the active prompt. */
export const activePromptAuthorSchema = z.object({
  userId: z.string(),
  canonicalUserId: z.string().nullable().optional(),
});

export type ActivePromptAuthor = z.infer<typeof activePromptAuthorSchema>;
