import { z } from "zod";

const attachmentBaseSchema = z.object({
  type: z.enum(["file", "image", "url"]),
  name: z.string().min(1),
  mimeType: z.string().min(1).optional(),
});

// Exactly one attachment source is allowed. Upload metadata is canonicalized
// from the durable upload row before enqueueing, so clients cannot combine an
// upload reference with arbitrary inline or remote content.
export const attachmentSchema = z.union([
  attachmentBaseSchema.extend({
    uploadId: z.string().min(1),
    content: z.never().optional(),
    url: z.never().optional(),
  }),
  attachmentBaseSchema.extend({
    content: z.string().min(1),
    uploadId: z.never().optional(),
    url: z.never().optional(),
  }),
  attachmentBaseSchema.extend({
    url: z.string().url(),
    uploadId: z.never().optional(),
    content: z.never().optional(),
  }),
]);

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
