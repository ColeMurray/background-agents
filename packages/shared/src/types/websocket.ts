import { z } from "zod";
import { sessionAttachmentReferencesSchema } from "./session-attachments";
import { viewRevisionSchema } from "./server-messages";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    token: z.string(),
    clientId: z.string(),
    viewProtocol: z.literal(2).optional(),
    resumeRevision: viewRevisionSchema.optional(),
    forceSnapshot: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    content: z.string(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
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
