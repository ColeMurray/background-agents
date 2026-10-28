import { z } from "zod";
import { MAX_SESSION_LIST_FILTER_IDS } from "../session-list-query";
import {
  sessionCapabilitiesSchema,
  sessionReadStateSchema,
  sessionSummaryBaseSchema,
} from "./sessions";
import { teamIdSchema } from "./team-id";
import { sessionVisibilitySchema } from "./teams";

/** Viewer-specific session row in session inbox page and snapshot payloads. */
export const sessionInboxSessionSchema = sessionSummaryBaseSchema.extend({
  readState: sessionReadStateSchema,
  capabilities: sessionCapabilitiesSchema.optional(),
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

/**
 * Marks every unread session the inbox lists under these filters as read for
 * the viewer, including sessions on pages the client has not loaded. The
 * filters mirror the inbox query parameters.
 */
export const sessionInboxMarkReadRequestSchema = z.strictObject({
  mine: z.boolean().optional(),
  teamIds: z.array(teamIdSchema).max(MAX_SESSION_LIST_FILTER_IDS).optional(),
  ownerFilter: z.enum(["started", "participating", "anyone"]).optional(),
  visibility: sessionVisibilitySchema.optional(),
  scope: z.enum(["workspace", "all"]).optional(),
  /** Limits marking to the inbox hierarchy rooted here: the session and its listed descendants. */
  rootSessionId: z.string().min(1).optional(),
});
export type SessionInboxMarkReadRequest = z.infer<typeof sessionInboxMarkReadRequestSchema>;

export const sessionInboxMarkReadResponseSchema = z.object({
  /** Sessions whose read state changed; zero when everything was already read. */
  markedCount: z.number().int().nonnegative(),
});
