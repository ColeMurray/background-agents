import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  eventTimelineCursorFromRow,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import type { EventChangeRow, EventRow } from "./types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type UpsertableEventType = TokenEvent["type"] | ExecutionCompleteEvent["type"];

const NEXT_TIMELINE_SEQUENCE_SQL = "(SELECT COALESCE(MAX(timeline_sequence), 0) + 1 FROM events)";

export interface CreateEventData {
  id: string;
  type: string;
  data: string;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventPageOptions {
  cursor?: EventListCursor | null;
  limit: number;
  type?: string | null;
  messageId?: string | null;
}

export interface ListEventTimelinePageOptions {
  cursor?: EventTimelineCursor | null;
  excludeTypes?: string[];
  limit: number;
}

export interface EventPage {
  events: EventRow[];
  hasMore: boolean;
  nextCursor: EventTimelineCursor | null;
}

export type EventFeedCursor =
  | {
      mode: "snapshot";
      scope: string;
      checkpoint: number;
      createdAt: number;
      timelineSequence: number;
    }
  | {
      mode: "changes";
      scope: string;
      checkpoint: number;
      revision: number;
    };

export interface EventChangePage {
  changes: EventChangeRow[];
  checkpoint: number;
  hasMore: boolean;
  nextCursor: EventFeedCursor | null;
}

export interface ListEventChangesOptions {
  after?: number;
  cursor?: EventFeedCursor;
  limit: number;
}

interface QueryEventPageOptions extends ListEventPageOptions {
  excludeTypes?: string[];
}

export class InvalidEventFeedCursorError extends Error {}

/** Persistence for events scoped to one session. */
export class EventRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  private appendUpsert(eventId: string): void {
    this.sql.exec(
      `INSERT INTO event_changes
       (kind, event_id, type, data, message_id, created_at, timeline_sequence)
       SELECT 'upsert', id, type, data, message_id, created_at, timeline_sequence
       FROM events WHERE id = ?`,
      eventId
    );
  }

  private appendDelete(eventId: string): void {
    this.sql.exec(`INSERT INTO event_changes (kind, event_id) VALUES ('delete', ?)`, eventId);
  }

  createEventWithinTransaction(data: CreateEventData): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt
    );
    this.appendUpsert(data.id);
  }

  createEvent(data: CreateEventData): void {
    this.transactionSync(() => this.createEventWithinTransaction(data));
  }

  createContextCompactionEvent(data: CreateEventData & { messageId: string }): void {
    this.transactionSync(() => {
      const oldId = `token:${data.messageId}`;
      const newId = `token:${data.messageId}:${data.id}`;
      const renamed = this.sql.exec(
        `UPDATE events SET id = ? WHERE id = ? RETURNING id`,
        newId,
        oldId
      );
      if (renamed.toArray().length === 1) {
        this.appendDelete(oldId);
        this.appendUpsert(newId);
      }
      this.createEventWithinTransaction(data);
    });
  }

  private upsertEventByMessageIdWithinTransaction<TType extends UpsertableEventType>(
    type: TType,
    messageId: string,
    event: Extract<SandboxEvent, { type: TType }>,
    createdAt: number
  ): void {
    const id = `${type}:${messageId}`;
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id,
         created_at = excluded.created_at`,
      id,
      type,
      JSON.stringify(event),
      messageId,
      createdAt
    );
    this.appendUpsert(id);
  }

  upsertTokenEvent(messageId: string, event: TokenEvent, createdAt: number): void {
    this.transactionSync(() =>
      this.upsertEventByMessageIdWithinTransaction("token", messageId, event, createdAt)
    );
  }

  upsertToolCallEvent(messageId: string, event: ToolCallEvent, createdAt: number): void {
    const id = `tool_call:${toolCallIdentityKey(event)}`;
    this.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
         VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           message_id = excluded.message_id`,
        id,
        event.type,
        JSON.stringify(event),
        messageId,
        createdAt
      );
      this.appendUpsert(id);
    });
  }

  upsertExecutionCompleteEventWithinTransaction(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.upsertEventByMessageIdWithinTransaction("execution_complete", messageId, event, createdAt);
  }

  upsertExecutionCompleteEvent(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.transactionSync(() =>
      this.upsertExecutionCompleteEventWithinTransaction(messageId, event, createdAt)
    );
  }

  deleteEventWithinTransaction(eventId: string): boolean {
    const deleted = this.sql.exec(`DELETE FROM events WHERE id = ? RETURNING id`, eventId);
    if (deleted.toArray().length === 0) return false;
    this.appendDelete(eventId);
    return true;
  }

  listEventPage(options: ListEventPageOptions): EventPage {
    return this.queryEventPage(options);
  }

  getEventTimelinePage(options: ListEventTimelinePageOptions): EventPage {
    const page = this.queryEventPage(options);
    return { ...page, events: [...page.events].reverse() };
  }

  listEventChanges(options: ListEventChangesOptions): EventChangePage {
    const highWater = (
      this.sql.exec(`SELECT COALESCE(MAX(revision), 0) AS revision FROM event_changes`).one() as {
        revision: number;
      }
    ).revision;
    const scope = (
      this.sql.exec(`SELECT cursor_scope FROM event_feed_state WHERE singleton = 1`).one() as {
        cursor_scope: string;
      }
    ).cursor_scope;
    if (
      options.cursor &&
      (options.cursor.scope !== scope ||
        options.cursor.checkpoint > highWater ||
        (options.cursor.mode === "changes" && options.cursor.revision > options.cursor.checkpoint))
    ) {
      throw new InvalidEventFeedCursorError("Invalid event feed cursor");
    }
    if (options.after !== undefined && options.after > highWater) {
      throw new InvalidEventFeedCursorError("Invalid event feed checkpoint");
    }

    const checkpoint = options.cursor?.checkpoint ?? highWater;
    const mode = options.cursor?.mode ?? (options.after === undefined ? "snapshot" : "changes");
    const rows =
      mode === "snapshot"
        ? this.listSnapshotChanges(checkpoint, options.cursor, options.limit)
        : this.listJournalChanges(checkpoint, options.after, options.cursor, options.limit);
    const hasMore = rows.length > options.limit;
    const changes = hasMore ? rows.slice(0, options.limit) : rows;
    const last = changes[changes.length - 1];
    return {
      changes,
      checkpoint,
      hasMore,
      nextCursor:
        hasMore && last
          ? last.kind === "upsert" && mode === "snapshot"
            ? {
                mode,
                scope,
                checkpoint,
                createdAt: last.created_at!,
                timelineSequence: last.timeline_sequence!,
              }
            : { mode: "changes", scope, checkpoint, revision: last.revision }
          : null,
    };
  }

  private listSnapshotChanges(
    checkpoint: number,
    cursor: EventFeedCursor | undefined,
    limit: number
  ): EventChangeRow[] {
    const position = cursor?.mode === "snapshot" ? cursor : null;
    const condition = position
      ? `AND (change.created_at > ? OR
          (change.created_at = ? AND change.timeline_sequence > ?))`
      : "";
    const params = position
      ? [checkpoint, position.createdAt, position.createdAt, position.timelineSequence, limit + 1]
      : [checkpoint, limit + 1];
    return this.sql
      .exec(
        `WITH latest AS (
           SELECT event_id, MAX(revision) AS revision
           FROM event_changes WHERE revision <= ? GROUP BY event_id
         )
         SELECT change.* FROM event_changes AS change
         JOIN latest USING (event_id, revision)
         WHERE change.kind = 'upsert' ${condition}
         ORDER BY change.created_at ASC, change.timeline_sequence ASC LIMIT ?`,
        ...params
      )
      .toArray() as EventChangeRow[];
  }

  private listJournalChanges(
    checkpoint: number,
    after: number | undefined,
    cursor: EventFeedCursor | undefined,
    limit: number
  ): EventChangeRow[] {
    const position = cursor?.mode === "changes" ? cursor.revision : (after ?? 0);
    return this.sql
      .exec(
        `SELECT * FROM event_changes
         WHERE revision > ? AND revision <= ?
         ORDER BY revision ASC LIMIT ?`,
        position,
        checkpoint,
        limit + 1
      )
      .toArray() as EventChangeRow[];
  }

  private queryEventPage(options: QueryEventPageOptions): EventPage {
    let query = `SELECT * FROM events`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push(`type = ?`);
      params.push(options.type);
    }
    if (options.messageId) {
      conditions.push(`message_id = ?`);
      params.push(options.messageId);
    }
    if (options.excludeTypes?.length) {
      conditions.push(`type NOT IN (${options.excludeTypes.map(() => "?").join(", ")})`);
      params.push(...options.excludeTypes);
    }

    const cursor = options.cursor;
    if (cursor?.kind === "timeline") {
      if (cursor.sequence !== undefined) {
        conditions.push(`((created_at < ?) OR (created_at = ? AND timeline_sequence < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.sequence);
      } else {
        conditions.push(`((created_at < ?) OR (created_at = ? AND id < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    } else if (cursor?.kind === "legacy") {
      conditions.push(`created_at < ?`);
      params.push(cursor.createdAt);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(" AND ")}`;

    const tieBreaker =
      cursor?.kind === "timeline" && cursor.sequence === undefined ? "id" : "timeline_sequence";
    query += ` ORDER BY created_at DESC, ${tieBreaker} DESC LIMIT ?`;
    params.push(options.limit + 1);

    const rows = this.sql.exec(query, ...params).toArray() as EventRow[];
    const hasMore = rows.length > options.limit;
    const events = hasMore ? rows.slice(0, options.limit) : rows;
    const nextCursor = events.length ? eventTimelineCursorFromRow(events[events.length - 1]) : null;
    return { events, hasMore, nextCursor };
  }
}
