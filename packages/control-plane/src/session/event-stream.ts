import type { ClientMessage } from "@open-inspect/shared/types/websocket";
import type { EventResponse, ListEventsResponse } from "@open-inspect/shared/types/sandbox-events";
import {
  encodeEventTimelineCursor,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { EventRow } from "./types";
import type { SessionRepository } from "./repository";
import {
  sessionTimelineEventSchema,
  type ServerMessage,
  type SessionTimelineEvent,
} from "@open-inspect/shared/types/server-messages";

export const DEFAULT_REPLAY_LIMIT = 500;
const DEFAULT_HISTORY_LIMIT = 200;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 500;
const HISTORY_EXCLUDED_TYPES = ["heartbeat"];

export type EventStreamCursor = NonNullable<
  Extract<ClientMessage, { type: "fetch_history" }>["cursor"]
>;
export type SessionTimeline = NonNullable<
  Extract<ServerMessage, { type: "subscribed" }>["timeline"]
>;
export type SessionHistoryPage = Omit<Extract<ServerMessage, { type: "history_page" }>, "type">;

export type SessionEventStreamRepository = Pick<
  SessionRepository,
  "getEventTimelinePage" | "listEventPage"
>;

export interface SessionEventListRequest {
  cursor: EventListCursor | null;
  limit: number;
  type: string | null;
  messageId: string | null;
}

export class SessionEventStream {
  constructor(private readonly repository: SessionEventStreamRepository) {}

  getReplay(limit = DEFAULT_REPLAY_LIMIT): SessionTimeline {
    const page = this.repository.getEventTimelinePage({
      excludeTypes: HISTORY_EXCLUDED_TYPES,
      limit,
    });

    return {
      events: parseSessionTimelineEvents(page.events),
      hasMore: page.hasMore,
      cursor: page.nextCursor ? toEventStreamCursor(page.nextCursor) : null,
    };
  }

  getHistoryPage(input: { cursor: EventStreamCursor; limit?: number }): SessionHistoryPage {
    const page = this.repository.getEventTimelinePage({
      cursor: {
        kind: "timeline",
        createdAt: input.cursor.timestamp,
        id: input.cursor.id,
        sequence: input.cursor.sequence,
      },
      excludeTypes: HISTORY_EXCLUDED_TYPES,
      limit: clampHistoryLimit(input.limit),
    });

    return {
      items: parseSessionTimelineEvents(page.events),
      hasMore: page.hasMore,
      cursor: page.nextCursor ? toEventStreamCursor(page.nextCursor) : null,
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

function parseSessionTimelineEvents(rows: EventRow[]): SessionTimelineEvent[] {
  const events: SessionTimelineEvent[] = [];
  for (const row of rows) {
    try {
      const event = sessionTimelineEventSchema.safeParse({
        eventId: row.id,
        timelineSequence: row.timeline_sequence,
        event: JSON.parse(row.data),
      });
      if (event.success) events.push(event.data);
    } catch {
      // A malformed persisted event must not prevent the rest of the timeline from loading.
    }
  }
  return events;
}

function toEventStreamCursor(cursor: EventTimelineCursor): EventStreamCursor {
  return {
    timestamp: cursor.createdAt,
    id: cursor.id,
    ...(cursor.sequence === undefined ? {} : { sequence: cursor.sequence }),
  };
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
