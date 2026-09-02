import { z } from "zod";
import { sessionAttachmentReferencesSchema } from "./session-attachments";

export const MAX_WEB_PROMPT_CHARS = 64_000;
export const MAX_UNFINISHED_PROMPTS = 50;
export const BLANK_PROMPT_MESSAGE = "Prompt content must not be blank without attachments";

export const clientRequestIdSchema = z.string().min(1).max(128);

export function isBlankPrompt(prompt: {
  content: string;
  attachments?: readonly unknown[];
}): boolean {
  return prompt.content.trim().length === 0 && (prompt.attachments?.length ?? 0) === 0;
}

export const promptContentSchema = z.string().max(MAX_WEB_PROMPT_CHARS);

export const webPromptPayloadSchema = z
  .object({
    content: promptContentSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
  })
  .refine((prompt) => !isBlankPrompt(prompt), {
    message: BLANK_PROMPT_MESSAGE,
    path: ["content"],
  });

export type WebPromptPayload = z.infer<typeof webPromptPayloadSchema>;
