import { z } from "zod";
import { sessionReadStateSchema, sessionSummaryBaseSchema } from "./sessions";

/** Viewer-specific session row in session inbox page and snapshot payloads. */
export const sessionInboxSessionSchema = sessionSummaryBaseSchema.extend({
  readState: sessionReadStateSchema,
});
export type SessionInboxSession = z.infer<typeof sessionInboxSessionSchema>;
/** @deprecated Use SessionInboxSession for this inbox-specific projection. */
export type SessionListItem = SessionInboxSession;

export const sessionInboxCategorySchema = z.enum(["needs_attention", "in_progress", "finished"]);
export type SessionInboxCategory = z.infer<typeof sessionInboxCategorySchema>;

export const sessionInboxItemSchema = z.object({
  rootSession: sessionInboxSessionSchema,
  descendantSessions: z.array(sessionInboxSessionSchema),
});
export type SessionInboxItem = z.infer<typeof sessionInboxItemSchema>;

export const sessionInboxPageSchema = z.object({
  items: z.array(sessionInboxItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type SessionInboxPage = z.infer<typeof sessionInboxPageSchema>;

export const sessionInboxSnapshotSchema = z.object({
  categories: z.object({
    needs_attention: sessionInboxPageSchema,
    in_progress: sessionInboxPageSchema,
    finished: sessionInboxPageSchema,
  }),
});
export type SessionInboxSnapshot = z.infer<typeof sessionInboxSnapshotSchema>;
