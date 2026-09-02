import type { SqlStorage } from "./sql-storage";

export interface PendingTerminalMessageProjection {
  messageId: string;
  messageCreatedAt: number;
  terminalMessageCompletedAt: number;
  /** Alarm-driven attempts so far; the inline attempts are not counted. */
  attempts: number;
  nextAttemptAt: number;
}

export interface TerminalMessageProjectionStore {
  pending(): PendingTerminalMessageProjection | null;
  /** Keeps whichever message is newer by `(createdAt, id)`; the same message keeps its retry metadata. */
  setPending(entry: PendingTerminalMessageProjection): void;
  /** Applies only while the named message is still the pending one. */
  recordFailedAttempt(update: {
    messageId: string;
    messageCreatedAt: number;
    attempts: number;
    nextAttemptAt: number;
  }): void;
  /** Drops the pending entry unless it is newer than the message that landed. */
  clearThrough(message: { messageId: string; messageCreatedAt: number }): void;
}

interface PendingRow {
  message_id: string;
  message_created_at: number;
  completed_at: number;
  attempts: number;
  next_attempt_at: number;
}

export class PersistedTerminalMessageProjectionStore implements TerminalMessageProjectionStore {
  constructor(private readonly sql: SqlStorage) {}

  pending(): PendingTerminalMessageProjection | null {
    const rows = this.sql
      .exec(
        `SELECT message_id, message_created_at, completed_at, attempts, next_attempt_at
         FROM terminal_message_projection_pending WHERE singleton = 1`
      )
      .toArray() as PendingRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      messageId: row.message_id,
      messageCreatedAt: row.message_created_at,
      terminalMessageCompletedAt: row.completed_at,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    };
  }

  setPending(entry: PendingTerminalMessageProjection): void {
    this.sql.exec(
      `INSERT INTO terminal_message_projection_pending
         (singleton, message_id, message_created_at, completed_at, attempts, next_attempt_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         message_id = excluded.message_id,
         message_created_at = excluded.message_created_at,
         completed_at = excluded.completed_at,
         attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at
       WHERE excluded.message_created_at > message_created_at
          OR (
            excluded.message_created_at = message_created_at
            AND excluded.message_id > message_id
          )`,
      entry.messageId,
      entry.messageCreatedAt,
      entry.terminalMessageCompletedAt,
      entry.attempts,
      entry.nextAttemptAt
    );
  }

  recordFailedAttempt(update: {
    messageId: string;
    messageCreatedAt: number;
    attempts: number;
    nextAttemptAt: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_message_projection_pending
       SET attempts = ?, next_attempt_at = ?
       WHERE singleton = 1 AND message_id = ? AND message_created_at = ?`,
      update.attempts,
      update.nextAttemptAt,
      update.messageId,
      update.messageCreatedAt
    );
  }

  clearThrough(message: { messageId: string; messageCreatedAt: number }): void {
    this.sql.exec(
      `DELETE FROM terminal_message_projection_pending
       WHERE singleton = 1
         AND (
           message_created_at < ?
           OR (message_created_at = ? AND message_id <= ?)
         )`,
      message.messageCreatedAt,
      message.messageCreatedAt,
      message.messageId
    );
  }
}
