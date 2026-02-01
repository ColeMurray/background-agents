/**
 * MessageRepository implementation using SQLite.
 */

import type {
  MessageRepository,
  CreateMessageData,
  ListMessagesOptions,
  ListMessagesResult,
} from "./types";
import type { MessageRow } from "../types";
import type { MessageStatus } from "../../types";

/**
 * Create a MessageRepository instance backed by SQLite.
 */
export function createMessageRepository(sql: SqlStorage): MessageRepository {
  return {
    getById(id: string): MessageRow | null {
      const result = sql.exec(`SELECT * FROM messages WHERE id = ? LIMIT 1`, id);
      const rows = result.toArray() as MessageRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    getProcessing(): MessageRow | null {
      const result = sql.exec(`SELECT * FROM messages WHERE status = ? LIMIT 1`, "processing");
      const rows = result.toArray() as MessageRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    getNextPending(): MessageRow | null {
      const result = sql.exec(
        `SELECT * FROM messages WHERE status = ? ORDER BY created_at ASC LIMIT 1`,
        "pending"
      );
      const rows = result.toArray() as MessageRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    create(data: CreateMessageData): MessageRow {
      sql.exec(
        `INSERT INTO messages (
          id, author_id, content, source, model, attachments, callback_context,
          status, error_message, created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.id,
        data.authorId,
        data.content,
        data.source,
        data.model ?? null,
        data.attachments ?? null,
        data.callbackContext ?? null,
        "pending",
        null,
        data.createdAt,
        null,
        null
      );

      const created = this.getById(data.id);
      if (!created) {
        throw new Error(`Failed to create message ${data.id}`);
      }
      return created;
    },

    updateStatus(
      id: string,
      status: MessageStatus,
      extras?: { startedAt?: number; completedAt?: number; errorMessage?: string }
    ): void {
      const sets: string[] = ["status = ?"];
      const params: (string | number | null)[] = [status];

      if (extras?.startedAt !== undefined) {
        sets.push("started_at = ?");
        params.push(extras.startedAt);
      }

      if (extras?.completedAt !== undefined) {
        sets.push("completed_at = ?");
        params.push(extras.completedAt);
      }

      if (extras?.errorMessage !== undefined) {
        sets.push("error_message = ?");
        params.push(extras.errorMessage);
      }

      sql.exec(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    },

    list(options: ListMessagesOptions): ListMessagesResult {
      const { limit = 100, offset = 0, status } = options;

      let query = "SELECT * FROM messages";
      const params: (string | number)[] = [];

      if (status) {
        query += " WHERE status = ?";
        params.push(status);
      }

      query += " ORDER BY created_at DESC";

      // Fetch one extra to determine if there are more results
      query += ` LIMIT ? OFFSET ?`;
      params.push(limit + 1, offset);

      const result = sql.exec(query, ...params);
      const rows = result.toArray() as MessageRow[];

      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;

      return { messages, hasMore };
    },

    count(): number {
      const result = sql.exec(`SELECT COUNT(*) as count FROM messages`);
      const rows = result.toArray() as Array<{ count: number }>;
      return rows[0]?.count ?? 0;
    },
  };
}
