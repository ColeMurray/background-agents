import { z } from "zod";

export const createSessionResponseSchema = z.object({
  sessionId: z.string(),
});

export const sendPromptResponseSchema = z.object({
  messageId: z.string(),
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SendPromptResponse = z.infer<typeof sendPromptResponseSchema>;
