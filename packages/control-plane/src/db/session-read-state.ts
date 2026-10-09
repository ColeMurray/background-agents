import {
  INITIAL_SESSION_READ_STATE_VERSION,
  type SessionReadState,
} from "@open-inspect/shared/types/sessions";
import { z } from "zod";

export const viewerReadStateRowSchema = z.union([
  z.object({
    unread: z.literal(0),
    latest_terminal_message_id: z.null(),
    latest_terminal_message_created_at: z.null(),
  }),
  z.object({
    unread: z.union([z.literal(0), z.literal(1)]),
    latest_terminal_message_id: z.string(),
    latest_terminal_message_created_at: z.number(),
  }),
]);

export type ViewerReadStateRow = z.infer<typeof viewerReadStateRowSchema>;

/** Requires `users AS viewer` and `session_read_states AS read_state` joins. */
export function unreadSql(sessionAlias: string): string {
  return `CASE
            WHEN ${sessionAlias}.latest_terminal_message_id IS NOT NULL
              AND ${sessionAlias}.latest_terminal_message_completed_at >= viewer.created_at
              AND (
                read_state.last_read_message_id IS NULL
                OR read_state.last_read_message_id
                  != ${sessionAlias}.latest_terminal_message_id
              )
            THEN 1 ELSE 0
          END`;
}

export function readStateFromRow(row: ViewerReadStateRow): SessionReadState {
  return row.latest_terminal_message_id === null
    ? {
        latestMessageId: null,
        unread: false,
        version: INITIAL_SESSION_READ_STATE_VERSION,
      }
    : {
        latestMessageId: row.latest_terminal_message_id,
        unread: row.unread === 1,
        version: row.latest_terminal_message_created_at,
      };
}
