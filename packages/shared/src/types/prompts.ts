import { z } from "zod";
import { sessionAttachmentReferencesSchema } from "./session-attachments";

export const MAX_WEB_PROMPT_CHARS = 64_000;
export const MAX_UNFINISHED_PROMPTS = 10;

export const promptContentSchema = z.string().max(MAX_WEB_PROMPT_CHARS);

export const webPromptPayloadSchema = z
  .object({
    content: promptContentSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
  })
  .refine((prompt) => prompt.content.trim().length > 0 || (prompt.attachments?.length ?? 0) > 0, {
    message: "Prompt content must not be blank without attachments",
    path: ["content"],
  });

export type WebPromptPayload = z.infer<typeof webPromptPayloadSchema>;
