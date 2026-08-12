import { z } from "zod";
import { webPromptPayloadSchema } from "./prompts";

export { MAX_UNFINISHED_PROMPTS, MAX_WEB_PROMPT_CHARS } from "./prompts";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    token: z.string(),
    clientId: z.string(),
    capabilities: z.array(z.literal("prompt_queue_updates")).optional(),
  }),
  webPromptPayloadSchema.extend({
    type: z.literal("prompt"),
    clientRequestId: z.string().min(1).max(128).optional(),
  }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("typing") }),
  z.object({
    type: z.literal("presence"),
    status: z.enum(["active", "idle"]),
    cursor: z.object({ line: z.number(), file: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("fetch_history"),
    cursor: z
      .object({
        timestamp: z.number(),
        id: z.string(),
        sequence: z.number().int().nonnegative().optional(),
      })
      .optional(),
    limit: z.number().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
