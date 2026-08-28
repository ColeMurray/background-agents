import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { PromptQueueItem } from "@open-inspect/shared/types/server-messages";
import type { MessageSource, MessageStatus } from "@open-inspect/shared/types/sessions";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import type { CreateEventData, EventRepository } from "./event-repository";
import type { SessionAttachmentRepository } from "./session-attachment-repository";
import type { SqlResult, SqlStorage, TransactionSync } from "./sql-storage";
import type { MessageRow } from "./types";

type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

export const STOP_CONFIRMATION_TIMEOUT_MS = 15_000;

interface RecordedMessageCompletion {
  messageId: string;
  messageCreatedAt: number;
  messageStartedAt: number | null;
  completedAt: number;
  status: "completed" | "failed";
}

/** Data for creating a message. */
export interface CreateMessageData {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  model?: string | null;
  reasoningEffort?: string | null;
  attachments?: string | null;
  callbackContext?: string | null;
  clientRequestId?: string | null;
  requestFingerprint?: string | null;
  autofixFeedbackKey?: string | null;
  autofixPrKey?: string | null;
  originContext?: string | null;
  status: MessageStatus;
  createdAt: number;
}

export interface AdmitAutofixMessageData {
  message: CreateMessageData;
  feedbackKey: string;
  pullRequestKey: string;
  originContext: string;
  attemptLimit: number | null;
  windowStart: number;
  sessionClosed: boolean;
}

export type AutofixMessageAdmission =
  | { kind: "enqueued"; messageId: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "rejected"; reason: "session_closed" | "queue_full" | "attempt_limit" };

/** Options for listing messages. */
export interface ListMessagesOptions {
  cursor?: string | null;
  limit: number;
  status?: string | null;
}

/** Persistence for messages scoped to one session. */
export class MessageRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
    private readonly attachments: SessionAttachmentRepository,
    private readonly eventRepository: EventRepository
  ) {}

  private rows<T>(result: SqlResult): T[] {
    return result.toArray() as T[];
  }

  getActiveDurationMs(): number {
    const result = this.sql.exec(
      `SELECT COALESCE(SUM(completed_at - started_at), 0) as duration_ms
       FROM messages
       WHERE started_at IS NOT NULL AND completed_at IS NOT NULL`
    );
    return (result.one() as { duration_ms: number }).duration_ms;
  }

  getMessageCount(): number {
    const result = this.sql.exec(`SELECT COUNT(*) as count FROM messages`);
    return (result.one() as { count: number }).count;
  }

  getPendingOrProcessingCount(): number {
    const result = this.sql.exec(
      `SELECT COUNT(*) as count FROM messages WHERE status IN ('pending', 'processing')`
    );
    return (result.one() as { count: number }).count;
  }

  getProcessingMessage(): { id: string } | null {
    const result = this.sql.exec(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`);
    const rows = result.toArray() as Array<{ id: string }>;
    return rows[0] ?? null;
  }

  getMessageAwaitingStopConfirmation(): { id: string; deadline: number } | null {
    const result = this.sql.exec(
      `SELECT id, stop_confirmation_deadline FROM messages
       WHERE stop_confirmation_deadline IS NOT NULL LIMIT 1`
    );
    const row = (result.toArray() as Array<{ id: string; stop_confirmation_deadline: number }>)[0];
    return row ? { id: row.id, deadline: row.stop_confirmation_deadline } : null;
  }

  markMessageAwaitingStopConfirmation(messageId: string, deadline: number): void {
    this.sql.exec(
      `UPDATE messages SET stop_confirmation_deadline = ? WHERE id = ?`,
      deadline,
      messageId
    );
  }

  clearMessageAwaitingStopConfirmation(messageId: string): void {
    this.sql.exec(`UPDATE messages SET stop_confirmation_deadline = NULL WHERE id = ?`, messageId);
  }

  getProcessingMessageWithCreatedAt(): { id: string; created_at: number } | null {
    const result = this.sql.exec(
      `SELECT id, created_at FROM messages WHERE status = 'processing' LIMIT 1`
    );
    const rows = result.toArray() as Array<{ id: string; created_at: number }>;
    return rows[0] ?? null;
  }

  getProcessingMessageWithStartedAt(): { id: string; started_at: number } | null {
    const result = this.sql.exec(
      `SELECT id, started_at FROM messages WHERE status = 'processing' LIMIT 1`
    );
    const rows = result.toArray() as Array<{ id: string; started_at: number }>;
    return rows[0] ?? null;
  }

  getNextPendingMessage(): MessageRow | null {
    const result = this.sql.exec(
      `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1`
    );
    const rows = this.rows<MessageRow>(result);
    return rows[0] ?? null;
  }

  getMessageByClientRequestId(clientRequestId: string): MessageRow | null {
    const result = this.sql.exec(
      `SELECT * FROM messages WHERE client_request_id = ? LIMIT 1`,
      clientRequestId
    );
    return this.rows<MessageRow>(result)[0] ?? null;
  }

  getAutofixMessageId(feedbackKey: string): string | null {
    const result = this.sql.exec(
      `SELECT id FROM messages WHERE autofix_feedback_key = ? LIMIT 1`,
      feedbackKey
    );
    return (result.toArray() as Array<{ id: string }>)[0]?.id ?? null;
  }

  getMessageStatus(messageId: string): MessageStatus | null {
    const result = this.sql.exec(`SELECT status FROM messages WHERE id = ? LIMIT 1`, messageId);
    return (result.toArray() as Array<{ status: MessageStatus }>)[0]?.status ?? null;
  }

  admitAutofixMessage(data: AdmitAutofixMessageData): AutofixMessageAdmission {
    return this.transactionSync(() => {
      const existingMessageId = this.getAutofixMessageId(data.feedbackKey);
      if (existingMessageId) {
        return { kind: "duplicate", messageId: existingMessageId };
      }
      if (data.sessionClosed) {
        return { kind: "rejected", reason: "session_closed" };
      }
      if (this.getPendingOrProcessingCount() >= MAX_UNFINISHED_PROMPTS) {
        return { kind: "rejected", reason: "queue_full" };
      }

      if (data.attemptLimit !== null) {
        const count = this.sql
          .exec(
            `SELECT COUNT(*) AS count FROM messages
           WHERE autofix_pr_key = ? AND created_at >= ?`,
            data.pullRequestKey,
            data.windowStart
          )
          .one() as { count: number };
        if (count.count >= data.attemptLimit) {
          return { kind: "rejected", reason: "attempt_limit" };
        }
      }

      this.createMessage({
        ...data.message,
        autofixFeedbackKey: data.feedbackKey,
        autofixPrKey: data.pullRequestKey,
        originContext: data.originContext,
      });
      return { kind: "enqueued", messageId: data.message.id };
    });
  }

  getUnfinishedMessagePosition(messageId: string): number | null {
    const result = this.sql.exec(
      `SELECT id FROM messages WHERE status IN ('pending', 'processing')
       ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`
    );
    const index = (result.toArray() as Array<{ id: string }>).findIndex(
      (row) => row.id === messageId
    );
    return index < 0 ? null : index + 1;
  }

  listUnfinishedMessages(): MessageRow[] {
    const result = this.sql.exec(
      `SELECT * FROM messages WHERE status IN ('pending', 'processing')
       ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`
    );
    return this.rows<MessageRow>(result);
  }

  listPromptQueue(): PromptQueueItem[] {
    return this.listUnfinishedMessages().map((message) => ({
      messageId: message.id,
      content: message.content,
      status: message.status as "pending" | "processing",
    }));
  }

  cancelPendingMessage(messageId: string): boolean {
    return this.transactionSync(() => {
      const result = this.sql.exec(
        `SELECT status, source, callback_context FROM messages WHERE id = ?`,
        messageId
      );
      const message = (
        result.toArray() as Array<{
          status: MessageStatus;
          source: string;
          callback_context: string | null;
        }>
      )[0];
      if (
        message?.status !== "pending" ||
        message.source !== "web" ||
        message.callback_context !== null
      ) {
        return false;
      }

      this.attachments.releaseForMessage(messageId);
      const deleted = this.sql.exec(
        `DELETE FROM messages WHERE id = ? AND status = 'pending'`,
        messageId
      );
      deleted.toArray();
      return deleted.rowsWritten === 1;
    });
  }

  getMessageCallbackContext(
    messageId: string
  ): { callback_context: string | null; source: string | null } | null {
    const result = this.sql.exec(
      `SELECT callback_context, source FROM messages WHERE id = ?`,
      messageId
    );
    const rows = result.toArray() as Array<{
      callback_context: string | null;
      source: string | null;
    }>;
    return rows[0] ?? null;
  }

  createMessage(data: CreateMessageData): void {
    this.sql.exec(
      `INSERT INTO messages (
         id, author_id, content, source, model, reasoning_effort, attachments,
         callback_context, client_request_id, request_fingerprint, autofix_feedback_key,
         autofix_pr_key, origin_context, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.authorId,
      data.content,
      data.source,
      data.model ?? null,
      data.reasoningEffort ?? null,
      data.attachments ?? null,
      data.callbackContext ?? null,
      data.clientRequestId ?? null,
      data.requestFingerprint ?? null,
      data.autofixFeedbackKey ?? null,
      data.autofixPrKey ?? null,
      data.originContext ?? null,
      data.status,
      data.createdAt
    );
  }

  /** Persist a message, its attachments, and canonical timeline event atomically. */
  createMessageWithAttachments(
    data: CreateMessageData,
    attachmentIds: string[],
    event?: CreateEventData
  ): void {
    this.transactionSync(() => {
      this.attachments.claimForMessage(data.id, attachmentIds);
      this.createMessage(data);
      if (event) this.eventRepository.createEvent(event);
    });
  }

  startMessageProcessing(
    messageId: string,
    startedAt: number,
    userMessageEvent: Extract<SandboxEvent, { type: "user_message" }>
  ): boolean {
    return this.transactionSync(() => {
      const claimed = this.sql.exec(
        `UPDATE messages SET status = 'processing', started_at = ?
         WHERE id = ? AND status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM messages WHERE status = 'processing')
         RETURNING id`,
        startedAt,
        messageId
      );
      if (claimed.toArray().length !== 1) return false;

      this.eventRepository.createEvent({
        id: `user_message:${messageId}`,
        type: "user_message",
        data: JSON.stringify(userMessageEvent),
        messageId,
        createdAt: startedAt,
      });
      return true;
    });
  }

  updateMessageToPending(messageId: string): void {
    this.transactionSync(() => {
      const updated = this.sql.exec(
        `UPDATE messages SET status = 'pending', started_at = NULL
         WHERE id = ? AND status = 'processing'
         RETURNING id`,
        messageId
      );
      if (updated.toArray().length === 1) {
        this.sql.exec(`DELETE FROM events WHERE id = ?`, `user_message:${messageId}`);
      }
    });
  }

  recordMessageCompletion(
    event: ExecutionCompleteEvent,
    completedAt: number,
    expectedStatus: "pending" | "processing"
  ): RecordedMessageCompletion | null {
    return this.transactionSync(() => {
      const result = this.sql.exec(
        `SELECT status, created_at, started_at FROM messages WHERE id = ?`,
        event.messageId
      );
      const message = (
        result.toArray() as Array<{
          status: MessageStatus;
          created_at: number;
          started_at: number | null;
        }>
      )[0];
      if (!message || message.status !== expectedStatus) return null;

      const status = event.success ? "completed" : "failed";
      this.sql.exec(
        `UPDATE messages SET status = ?, completed_at = ?, error_message = ? WHERE id = ?`,
        status,
        completedAt,
        event.success ? null : (event.error ?? null),
        event.messageId
      );
      this.eventRepository.upsertExecutionCompleteEvent(event.messageId, event, completedAt);

      return {
        messageId: event.messageId,
        messageCreatedAt: message.created_at,
        messageStartedAt: message.started_at,
        completedAt,
        status,
      };
    });
  }

  listPendingMessagesWithCreatedAt(): Array<{ id: string; created_at: number }> {
    const result = this.sql.exec(
      `SELECT id, created_at FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC`
    );
    return result.toArray() as Array<{ id: string; created_at: number }>;
  }

  listMessages(options: ListMessagesOptions): MessageRow[] {
    let query = `SELECT * FROM messages WHERE 1=1`;
    const params: (string | number)[] = [];

    if (options.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }

    if (options.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(options.limit + 1);

    const result = this.sql.exec(query, ...params);
    return this.rows<MessageRow>(result);
  }

  getLatestTerminalMessage(): MessageRow | null {
    const result = this.sql.exec(
      `SELECT * FROM messages
       WHERE status IN ('completed', 'failed')
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC, created_at DESC, id DESC
       LIMIT 1`
    );
    const rows = this.rows<MessageRow>(result);
    return rows[0] ?? null;
  }

  getProcessingMessageAuthor(): { author_id: string } | null {
    const result = this.sql.exec(
      `SELECT author_id FROM messages WHERE status = 'processing' LIMIT 1`
    );
    const rows = result.toArray() as Array<{ author_id: string }>;
    return rows[0] ?? null;
  }
}
