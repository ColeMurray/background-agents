import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { PromptQueueItem } from "@open-inspect/shared/types/server-messages";
import type { MessageSource, MessageStatus } from "@open-inspect/shared/types/sessions";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import type { CreateEventData, EventRepository } from "./event-repository";
import type { SessionAttachmentRepository } from "./session-attachment-repository";
import type { SqlResult, SqlStorage, TransactionSync } from "./sql-storage";
import type { MessageRow } from "./types";
import type { ExecutionBudget } from "./execution-deadline";

type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

export const STOP_CONFIRMATION_TIMEOUT_MS = 15_000;

export interface MessageExecutionMetadata {
  execution_deadline_ms: number | null;
  cleanup_deadline_ms: number | null;
  cleanup_reserve_ms?: number | null;
  execution_sandbox_id: string | null;
  requires_stop_evidence: number;
}

export interface RecordedMessageCompletion {
  messageId: string;
  messageCreatedAt: number;
  messageStartedAt: number | null;
  completedAt: number;
  status: "completed" | "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequiredNumberColumn(result: SqlResult, column: string): number {
  const row = result.one();
  if (!isRecord(row) || typeof row[column] !== "number") {
    throw new Error(`Malformed numeric SQL result for ${column}`);
  }
  return row[column];
}

function parseMessageStatus(value: unknown): MessageStatus | null {
  return value === "pending" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed"
    ? value
    : null;
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
  message: Omit<CreateMessageData, "authorId"> & { authorId: string | (() => string) };
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
  | {
      kind: "rejected";
      reason: "session_closed" | "budget_exhausted" | "queue_full" | "attempt_limit";
    };

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
    return readRequiredNumberColumn(result, "count");
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

  getMessageExecutionMetadata(messageId: string): MessageExecutionMetadata | null {
    return (
      (
        this.sql
          .exec(
            `SELECT execution_deadline_ms, cleanup_deadline_ms, cleanup_reserve_ms, execution_sandbox_id,
              requires_stop_evidence FROM messages WHERE id = ?`,
            messageId
          )
          .toArray() as MessageExecutionMetadata[]
      )[0] ?? null
    );
  }

  /** Early completion/Stop starts the one cleanup interval, never renews it. */
  beginMessageCleanup(messageId: string, now: number, observedDeadlineMs?: number): number | null {
    if (observedDeadlineMs !== undefined) {
      this.sql.exec(
        `UPDATE messages SET cleanup_deadline_ms = MIN(COALESCE(cleanup_deadline_ms, ?), ?)
         WHERE id = ?`,
        observedDeadlineMs,
        observedDeadlineMs,
        messageId
      );
    }
    const row = (
      this.sql
        .exec(
          `UPDATE messages SET cleanup_deadline_ms = MIN(cleanup_deadline_ms, ? + cleanup_reserve_ms)
       WHERE id = ? AND cleanup_reserve_ms IS NOT NULL
       RETURNING cleanup_deadline_ms`,
          now,
          messageId
        )
        .toArray() as Array<{ cleanup_deadline_ms: number }>
    )[0];
    return row?.cleanup_deadline_ms ?? observedDeadlineMs ?? null;
  }

  getAutomationMessage(runId: string): Pick<MessageRow, "id" | "status" | "error_message"> | null {
    return (
      (
        this.sql
          .exec(
            `SELECT id, status, error_message FROM messages
       WHERE json_valid(callback_context)
         AND json_extract(callback_context, '$.source') = 'automation'
         AND json_extract(callback_context, '$.runId') = ?
       ORDER BY created_at, rowid LIMIT 1`,
            runId
          )
          .toArray() as Array<Pick<MessageRow, "id" | "status" | "error_message">>
      )[0] ?? null
    );
  }

  hasExecutionLaunch(launchId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT id FROM messages WHERE json_valid(callback_context)
         AND json_extract(callback_context, '$.executionLaunchId') = ? LIMIT 1`,
          launchId
        )
        .toArray().length > 0
    );
  }

  /** A delayed ready frame must upgrade the already-dispatched turn as well. */
  requireStopEvidenceForSandbox(sandboxId: string): void {
    this.sql.exec(
      `UPDATE messages SET requires_stop_evidence = 1
       WHERE execution_sandbox_id = ?
         AND (status = 'processing' OR stop_confirmation_deadline IS NOT NULL)`,
      sandboxId
    );
  }

  requireStopEvidenceForMessage(messageId: string, sandboxId: string): void {
    this.sql.exec(
      `UPDATE messages SET requires_stop_evidence = 1,
         execution_sandbox_id = COALESCE(execution_sandbox_id, ?)
       WHERE id = ? AND (execution_sandbox_id IS NULL OR execution_sandbox_id = ?)
         AND (status = 'processing' OR stop_confirmation_deadline IS NOT NULL)`,
      sandboxId,
      messageId,
      sandboxId
    );
  }

  markMessageAwaitingStopConfirmation(messageId: string, deadline: number): void {
    this.sql.exec(
      `UPDATE messages SET stop_confirmation_deadline = ? WHERE id = ?`,
      deadline,
      messageId
    );
  }

  /**
   * Record the runtime's cumulative cost report for a turn and return how much
   * it exceeds the highest report already stored. Resends, out-of-order
   * reports, and unknown messages return 0.
   */
  raiseReportedCost(messageId: string, reportedCostUsd: number): number {
    if (!Number.isFinite(reportedCostUsd) || reportedCostUsd <= 0) return 0;
    // Read-then-write: callers hold the storage transaction, and RETURNING
    // would only expose the post-update value.
    const rows = this.sql
      .exec(`SELECT reported_cost_usd FROM messages WHERE id = ?`, messageId)
      .toArray() as Array<{ reported_cost_usd: number }>;
    if (rows.length !== 1) return 0;
    const previous = rows[0].reported_cost_usd;
    if (reportedCostUsd <= previous) return 0;
    this.sql.exec(
      `UPDATE messages SET reported_cost_usd = ? WHERE id = ?`,
      reportedCostUsd,
      messageId
    );
    return reportedCostUsd - previous;
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

  getMessageContent(messageId: string): string | null {
    const result = this.sql.exec(`SELECT content FROM messages WHERE id = ? LIMIT 1`, messageId);
    return (result.toArray() as Array<{ content: string }>)[0]?.content ?? null;
  }

  getMessageStatus(messageId: string): MessageStatus | null {
    const result = this.sql.exec(`SELECT status FROM messages WHERE id = ? LIMIT 1`, messageId);
    return parseMessageStatus((result.toArray() as Array<{ status?: unknown }>)[0]?.status);
  }

  admitAutofixMessage(data: AdmitAutofixMessageData): AutofixMessageAdmission {
    return this.transactionSync(() => {
      const existingMessageId = this.getAutofixMessageId(data.feedbackKey);
      if (existingMessageId) {
        return { kind: "duplicate", messageId: existingMessageId };
      }
      const budget = (
        this.sql.exec(`SELECT budget_exhausted FROM session LIMIT 1`).toArray() as Array<{
          budget_exhausted: number;
        }>
      )[0];
      if (budget?.budget_exhausted === 1) {
        return { kind: "rejected", reason: "budget_exhausted" };
      }
      if (data.sessionClosed) {
        return { kind: "rejected", reason: "session_closed" };
      }
      if (this.getPendingOrProcessingCount() >= MAX_UNFINISHED_PROMPTS) {
        return { kind: "rejected", reason: "queue_full" };
      }

      if (data.attemptLimit !== null) {
        const countResult = this.sql.exec(
          `SELECT COUNT(*) AS count FROM messages
           WHERE autofix_pr_key = ? AND created_at >= ?`,
          data.pullRequestKey,
          data.windowStart
        );
        if (readRequiredNumberColumn(countResult, "count") >= data.attemptLimit) {
          return { kind: "rejected", reason: "attempt_limit" };
        }
      }

      this.createMessage({
        ...data.message,
        authorId:
          typeof data.message.authorId === "function"
            ? data.message.authorId()
            : data.message.authorId,
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
    return this.listUnfinishedMessages().flatMap((message) => {
      const status = parseMessageStatus(message.status);
      return status === "pending" || status === "processing"
        ? [{ messageId: message.id, content: message.content, status }]
        : [];
    });
  }

  cancelPendingMessage(messageId: string): boolean {
    return this.transactionSync(() => {
      const result = this.sql.exec(
        `SELECT status, source, callback_context, stop_confirmation_deadline FROM messages WHERE id = ?`,
        messageId
      );
      const message = (
        result.toArray() as Array<{
          status?: unknown;
          source: string;
          callback_context: string | null;
          stop_confirmation_deadline?: number | null;
        }>
      )[0];
      const status = parseMessageStatus(message?.status);
      if (
        !message ||
        status !== "pending" ||
        message.stop_confirmation_deadline != null ||
        message.source !== "web" ||
        message.callback_context !== null
      ) {
        return false;
      }

      this.attachments.releaseForMessage(messageId);
      const deleted = this.sql.exec(
        `DELETE FROM messages WHERE id = ? AND status = 'pending' AND stop_confirmation_deadline IS NULL`,
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
    userMessageEvent: Extract<SandboxEvent, { type: "user_message" }>,
    budget?: ExecutionBudget
  ): boolean {
    return this.transactionSync(() => {
      const claimed = this.sql.exec(
        `UPDATE messages SET status = 'processing', started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM messages WHERE status = 'processing')
           AND NOT EXISTS (SELECT 1 FROM messages WHERE stop_confirmation_deadline IS NOT NULL)
         RETURNING id`,
        startedAt,
        messageId
      );
      if (claimed.toArray().length !== 1) return false;

      if (budget) {
        this.sql.exec(
          `UPDATE messages SET execution_deadline_ms = MIN(COALESCE(execution_deadline_ms, ?), ?),
             cleanup_deadline_ms = MIN(COALESCE(cleanup_deadline_ms, ?), ?),
             cleanup_reserve_ms = COALESCE(cleanup_reserve_ms, ?),
             execution_sandbox_id = ?, requires_stop_evidence = ? WHERE id = ?`,
          budget.executionDeadlineMs,
          budget.executionDeadlineMs,
          budget.cleanupDeadlineMs,
          budget.cleanupDeadlineMs,
          budget.cleanupReserveMs,
          budget.sandboxId,
          budget.requiresStopEvidence ? 1 : 0,
          messageId
        );
      }

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
        `UPDATE messages SET status = 'pending'
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
          status?: unknown;
          created_at: number;
          started_at: number | null;
        }>
      )[0];
      const messageStatus = parseMessageStatus(message?.status);
      if (!message || messageStatus !== expectedStatus) return null;

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
