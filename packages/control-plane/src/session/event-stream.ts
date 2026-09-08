import type {
  ClientMessage,
  EventResponse,
  ListEventsResponse,
  SandboxEvent,
  ServerMessage,
} from "../types";
import { encodeEventTimelineCursor, type EventListCursor } from "./event-cursor";
import type { EventRow } from "./types";
import type { SessionRepository } from "./repository";

const DEFAULT_REPLAY_LIMIT = 500;
const DEFAULT_HISTORY_LIMIT = 200;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 500;
const HISTORY_EXCLUDED_TYPES = ["heartbeat"];

export type EventStreamCursor = NonNullable<
  Extract<ClientMessage, { type: "fetch_history" }>["cursor"]
>;
export type SessionReplay = NonNullable<Extract<ServerMessage, { type: "subscribed" }>["replay"]>;
export type SessionHistoryPage = Omit<Extract<ServerMessage, { type: "history_page" }>, "type">;

export type SessionEventStreamRepository = Pick<
  SessionRepository,
  "getEventsForReplay" | "getEventTimelinePage" | "listEventPage"
>;

export interface SessionEventListRequest {
  cursor: EventListCursor | null;
  limit: number;
  type: string | null;
  messageId: string | null;
}

export class SessionEventStream {
  constructor(private readonly repository: SessionEventStreamRepository) {}

  getReplay(limit = DEFAULT_REPLAY_LIMIT): SessionReplay {
    const rows = this.repository.getEventsForReplay(limit);
    const events = parseSandboxEvents(rows);
    const cursor = rows.length > 0 ? cursorFromRow(rows[0]) : null;

    return {
      events,
      hasMore: rows.length >= limit,
      cursor,
    };
  }

  getHistoryPage(input: { cursor: EventStreamCursor; limit?: number }): SessionHistoryPage {
    const page = this.repository.getEventTimelinePage({
      cursor: {
        kind: "timeline",
        createdAt: input.cursor.timestamp,
        id: input.cursor.id,
      },
      excludeTypes: HISTORY_EXCLUDED_TYPES,
      limit: clampHistoryLimit(input.limit),
    });

    return {
      items: parseSandboxEvents(page.events),
      hasMore: page.hasMore,
      cursor: page.nextCursor
        ? { timestamp: page.nextCursor.createdAt, id: page.nextCursor.id }
        : null,
    };
  }

  listEvents(request: SessionEventListRequest): ListEventsResponse {
    const page = this.repository.listEventPage({
      cursor: request.cursor,
      limit: request.limit,
      type: request.type,
      messageId: request.messageId,
    });

    return {
      events: page.events.map(toEventResponse),
      cursor: page.nextCursor ? encodeEventTimelineCursor(page.nextCursor) : undefined,
      hasMore: page.hasMore,
    };
  }
}

function parseSandboxEvents(rows: EventRow[]): SandboxEvent[] {
  const events: SandboxEvent[] = [];
  for (const row of rows) {
    try {
      events.push(JSON.parse(row.data) as SandboxEvent);
    } catch {
      // Preserve existing replay/history behavior: malformed events are skipped.
    }
  }
  return events;
}

function cursorFromRow(row: Pick<EventRow, "created_at" | "id">): EventStreamCursor {
  return { timestamp: row.created_at, id: row.id };
}

function toEventResponse(event: EventRow): EventResponse {
  return {
    id: event.id,
    type: event.type,
    data: JSON.parse(event.data) as Record<string, unknown>,
    messageId: event.message_id,
    createdAt: event.created_at,
  };
}

function clampHistoryLimit(limit: number | undefined): number {
  const rawLimit = typeof limit === "number" ? limit : DEFAULT_HISTORY_LIMIT;
  return Math.max(MIN_HISTORY_LIMIT, Math.min(rawLimit, MAX_HISTORY_LIMIT));
}
