import { messageSourceSchema } from "@open-inspect/shared/types/sessions";
import { sessionAttachmentReferencesSchema } from "@open-inspect/shared/types/session-attachments";
import {
  BLANK_PROMPT_MESSAGE,
  clientRequestIdSchema,
  isBlankPrompt,
  promptContentSchema,
} from "@open-inspect/shared/types/prompts";
import { z } from "zod";

export const enqueuePromptRequestSchema = z
  .object({
    content: promptContentSchema,
    authorId: z.string(),
    canonicalUserId: z.string().nullable().optional(),
    source: messageSourceSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
    callbackContext: z.record(z.string(), z.unknown()).optional(),
    clientRequestId: clientRequestIdSchema.optional(),
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
  })
  .refine((prompt) => !isBlankPrompt(prompt), {
    message: BLANK_PROMPT_MESSAGE,
    path: ["content"],
  });

export type EnqueuePromptRequest = z.infer<typeof enqueuePromptRequestSchema>;
