import { z } from "zod";
import { sessionReadStateSchema, sessionSummaryBaseSchema } from "./sessions";

/** Viewer-specific session row in session inbox page and snapshot payloads. */
export const sessionInboxSessionSchema = sessionSummaryBaseSchema.extend({
  readState: sessionReadStateSchema,
});
export type SessionInboxSession = z.infer<typeof sessionInboxSessionSchema>;
/** @deprecated Use SessionInboxSession for this inbox-specific projection. */
export type SessionListItem = SessionInboxSession;

export const SESSION_INBOX_CATEGORIES = ["needs_attention", "in_progress", "finished"] as const;
export const sessionInboxCategorySchema = z.enum(SESSION_INBOX_CATEGORIES);
export type SessionInboxCategory = z.infer<typeof sessionInboxCategorySchema>;

export const sessionInboxItemSchema = z.object({
  rootSession: sessionInboxSessionSchema,
  descendantSessions: z.array(sessionInboxSessionSchema),
});
export type SessionInboxItem = z.infer<typeof sessionInboxItemSchema>;

export const sessionInboxPageSchema = z.discriminatedUnion("hasMore", [
  z.object({
    items: z.array(sessionInboxItemSchema),
    hasMore: z.literal(true),
    nextCursor: z.string().min(1),
  }),
  z.object({
    items: z.array(sessionInboxItemSchema),
    hasMore: z.literal(false),
    nextCursor: z.null(),
  }),
]);
export type SessionInboxPage = z.infer<typeof sessionInboxPageSchema>;

export const sessionInboxSnapshotSchema = z.object({
  categories: z.record(sessionInboxCategorySchema, sessionInboxPageSchema),
});
export type SessionInboxSnapshot = z.infer<typeof sessionInboxSnapshotSchema>;
