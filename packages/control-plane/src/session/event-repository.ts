import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  eventTimelineCursorFromRow,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import type { EventRow } from "./types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type UpsertableEventType = TokenEvent["type"] | ExecutionCompleteEvent["type"];

const NEXT_TIMELINE_SEQUENCE_SQL = "(SELECT COALESCE(MAX(timeline_sequence), 0) + 1 FROM events)";

/**
 * Data for creating an event. Type is open because sandboxes emit additional
 * event types beyond the shared EventType union.
 */
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

interface QueryEventPageOptions extends ListEventPageOptions {
  excludeTypes?: string[];
}

/** Persistence for events scoped to one session. */
export class EventRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  createEvent(data: CreateEventData): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt
    );
  }

  createContextCompactionEvent(data: CreateEventData & { messageId: string }): void {
    this.transactionSync(() => {
      this.sql.exec(
        `UPDATE events SET id = ? WHERE id = ?`,
        `token:${data.messageId}:${data.id}`,
        `token:${data.messageId}`
      );
      this.createEvent(data);
    });
  }

  private upsertEventByMessageId<TType extends UpsertableEventType>(
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
  }

  upsertTokenEvent(messageId: string, event: TokenEvent, createdAt: number): void {
    this.upsertEventByMessageId("token", messageId, event, createdAt);
  }

  upsertToolCallEvent(messageId: string, event: ToolCallEvent, createdAt: number): void {
    const id = `tool_call:${toolCallIdentityKey(event)}`;
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
  }

  upsertExecutionCompleteEvent(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.upsertEventByMessageId("execution_complete", messageId, event, createdAt);
  }

  listEventPage(options: ListEventPageOptions): EventPage {
    return this.queryEventPage(options);
  }

  getEventTimelinePage(options: ListEventTimelinePageOptions): EventPage {
    const page = this.queryEventPage(options);
    return { ...page, events: [...page.events].reverse() };
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
