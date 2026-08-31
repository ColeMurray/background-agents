import { z } from "zod";
import { clientRequestIdSchema, webPromptPayloadSchema } from "./prompts";

export { clientRequestIdSchema, MAX_UNFINISHED_PROMPTS, MAX_WEB_PROMPT_CHARS } from "./prompts";

/** Standard close code for a transient server-side failure. */
export const WS_CLOSE_INTERNAL_ERROR = 1011;

/** Signals that the browser must discard its credential and reconnect fresh. */
export const WS_CLOSE_AUTHORIZATION_REVOKED = 4010;

export const WS_AUTHORIZATION_REVOKED_REASON = "Authorization expired or changed";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    token: z.string(),
    clientId: z.string(),
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
