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

export function promptValidationError(
  error: z.ZodError,
  raw: unknown
): { error: string; code?: "prompt_too_long" } {
  const issue = error.issues[0];
  const field = issue?.path.join(".");
  const content = raw && typeof raw === "object" && "content" in raw ? raw.content : undefined;

  if (field === "content" && issue?.code === "too_big" && typeof content === "string") {
    return {
      error: `content exceeds ${MAX_WEB_PROMPT_CHARS} characters (got ${content.length})`,
      code: "prompt_too_long",
    };
  }
  if (field === "content" && (issue?.message === BLANK_PROMPT_MESSAGE || content === undefined)) {
    return { error: "content is required" };
  }
  return { error: field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid prompt") };
}

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
