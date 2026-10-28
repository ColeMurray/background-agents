import { z } from "zod";

/** Non-secret identity needed to attribute work initiated by the active prompt. */
export const activePromptAuthorSchema = z.object({
  userId: z.string(),
  canonicalUserId: z.string().nullable().optional(),
  scmUserId: z.string().nullable(),
  scmLogin: z.string().nullable(),
  scmName: z.string().nullable(),
  scmEmail: z.string().nullable(),
  /**
   * The account the active prompt was queued under, which later identity links never change; null
   * for an Autofix turn or an author without an account.
   */
  promptAccountUserId: z.string().nullable().optional(),
});

export type ActivePromptAuthor = z.infer<typeof activePromptAuthorSchema>;
