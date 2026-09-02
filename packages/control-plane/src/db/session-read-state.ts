import type { SessionReadState } from "@open-inspect/shared/types/sessions";

export interface ViewerReadStateRow {
  unread: number;
  latest_terminal_message_id: string | null;
  latest_terminal_message_created_at: number | null;
}

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
    ? { latestMessageId: null, unread: false, version: 0 }
    : {
        latestMessageId: row.latest_terminal_message_id,
        unread: row.unread === 1,
        version: row.latest_terminal_message_created_at ?? 0,
      };
}
