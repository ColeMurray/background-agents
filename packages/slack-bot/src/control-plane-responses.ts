import { z } from "zod";

export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  status: z.string().min(1),
});

export const sendPromptResponseSchema = z.object({
  messageId: z.string().min(1),
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SendPromptResponse = z.infer<typeof sendPromptResponseSchema>;
