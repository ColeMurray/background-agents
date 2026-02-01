/**
 * EventRepository implementation using SQLite.
 */

import type { EventRepository, CreateEventData, ListEventsOptions } from "./types";
import type { EventRow } from "../types";

/**
 * Create an EventRepository instance backed by SQLite.
 */
export function createEventRepository(sql: SqlStorage): EventRepository {
  return {
    getById(id: string): EventRow | null {
      const result = sql.exec(`SELECT * FROM events WHERE id = ? LIMIT 1`, id);
      const rows = result.toArray() as EventRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    create(data: CreateEventData): EventRow {
      sql.exec(
        `INSERT INTO events (id, type, data, message_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        data.id,
        data.type,
        data.data,
        data.messageId ?? null,
        data.createdAt
      );

      const created = this.getById(data.id);
      if (!created) {
        throw new Error(`Failed to create event ${data.id}`);
      }
      return created;
    },

    list(options: ListEventsOptions): EventRow[] {
      const { limit, messageId, types } = options;

      let query = "SELECT * FROM events";
      const params: (string | number)[] = [];
      const whereClauses: string[] = [];

      // Filter by message ID
      if (messageId) {
        whereClauses.push("message_id = ?");
        params.push(messageId);
      }

      // Filter by event types (IN clause)
      if (types && types.length > 0) {
        const placeholders = types.map(() => "?").join(", ");
        whereClauses.push(`type IN (${placeholders})`);
        params.push(...types);
      }

      if (whereClauses.length > 0) {
        query += ` WHERE ${whereClauses.join(" AND ")}`;
      }

      // Always order by created_at ascending
      query += " ORDER BY created_at ASC";

      // Apply limit if provided
      if (limit) {
        query += " LIMIT ?";
        params.push(limit);
      }

      const result = sql.exec(query, ...params);
      return result.toArray() as EventRow[];
    },
  };
}
