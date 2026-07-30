import { messageSourceSchema, sessionAttachmentReferencesSchema } from "@open-inspect/shared";
import { z } from "zod";

export const enqueuePromptRequestSchema = z.object({
  content: z.string(),
  authorId: z.string(),
  canonicalUserId: z.string().nullable().optional(),
  source: messageSourceSchema,
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  attachments: sessionAttachmentReferencesSchema.optional(),
  callbackContext: z.record(z.string(), z.unknown()).optional(),
  // Trusted SCM enrichment resolved by the router at prompt time.
  scmEnrichment: z
    .object({
      userId: z.string().nullable(),
      login: z.string().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      accessTokenEncrypted: z.string().nullable(),
      refreshTokenEncrypted: z.string().nullable(),
      tokenExpiresAt: z.number().nullable(),
    })
    .optional(),
});

export type EnqueuePromptRequest = z.infer<typeof enqueuePromptRequestSchema>;
