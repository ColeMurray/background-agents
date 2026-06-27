import { z } from "zod";

// Attachment to a message
export const attachmentSchema = z.object({
  type: z.enum(["file", "image", "url"]),
  name: z.string(),
  url: z.string().optional(),
  content: z.string().optional(),
  mimeType: z.string().optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), token: z.string(), clientId: z.string() }),
  z.object({
    type: z.literal("prompt"),
    content: z.string(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: z.array(attachmentSchema).optional(),
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
    cursor: z.object({ timestamp: z.number(), id: z.string() }).optional(),
    limit: z.number().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
