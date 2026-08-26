import { z } from "zod";

/** Non-secret identity needed to attribute work initiated by the active prompt. */
export const activePromptAuthorSchema = z.object({
  userId: z.string(),
  canonicalUserId: z.string().nullable().optional(),
  scmUserId: z.string().nullable(),
  scmLogin: z.string().nullable(),
  scmName: z.string().nullable(),
  scmEmail: z.string().nullable(),
});

export type ActivePromptAuthor = z.infer<typeof activePromptAuthorSchema>;
