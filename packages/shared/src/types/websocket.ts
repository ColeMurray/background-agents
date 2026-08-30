import { z } from "zod";
import { clientRequestIdSchema, webPromptPayloadSchema } from "./prompts";

export { clientRequestIdSchema, MAX_UNFINISHED_PROMPTS, MAX_WEB_PROMPT_CHARS } from "./prompts";

export const SESSION_BUDGET_CAPABILITY = "session_budget" as const;
export const clientCapabilitySchema = z.literal(SESSION_BUDGET_CAPABILITY);
export type ClientCapability = z.infer<typeof clientCapabilitySchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    token: z.string(),
    clientId: z.string(),
    capabilities: z.array(clientCapabilitySchema).optional(),
  }),
  webPromptPayloadSchema.extend({
    type: z.literal("prompt"),
    clientRequestId: clientRequestIdSchema,
  }),
  z.object({
    type: z.literal("cancel_prompt"),
    messageId: z.string().min(1),
    clientRequestId: clientRequestIdSchema,
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
