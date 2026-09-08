import type { ClientMessage } from "@open-inspect/shared/types/websocket";
import {
  eventResponseSchema,
  type EventResponse,
  type ListEventsResponse,
} from "@open-inspect/shared/types/sandbox-events";
import {
  encodeEventTimelineCursor,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { EventRow } from "./types";
import type { EventFeedCursor, EventRepository, ListEventChangesOptions } from "./event-repository";
import type { SessionEventChangePage } from "./contracts";
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

export interface SessionEventListRequest {
  cursor: EventListCursor | null;
  limit: number;
  type: string | null;
  messageId: string | null;
}

export class SessionEventStream {
  constructor(private readonly repository: EventRepository) {}

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

  listEventChanges(request: ListEventChangesOptions): SessionEventChangePage {
    const page = this.repository.listEventChanges(request);
    return {
      changes: page.changes.map((change) =>
        change.kind === "delete"
          ? { kind: change.kind, revision: change.revision, eventId: change.event_id }
          : {
              kind: change.kind,
              revision: change.revision,
              event: toEventResponse({
                id: change.event_id,
                type: change.type!,
                data: change.data!,
                message_id: change.message_id,
                created_at: change.created_at!,
                timeline_sequence: change.timeline_sequence!,
              }),
            }
      ),
      checkpoint: page.checkpoint,
      ...(page.nextCursor === null ? {} : { cursor: encodeEventChangeCursor(page.nextCursor) }),
      hasMore: page.hasMore,
    };
  }
}

export function encodeEventChangeCursor(cursor: EventFeedCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function parseEventChangeCursor(value: string): EventFeedCursor | null {
  try {
    const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))
    ) as Record<string, unknown>;
    if (
      (parsed.mode !== "snapshot" && parsed.mode !== "changes") ||
      typeof parsed.scope !== "string" ||
      !/^[a-f0-9]{32}$/.test(parsed.scope) ||
      !isCheckpoint(parsed.checkpoint)
    ) {
      return null;
    }
    if (
      parsed.mode === "snapshot" &&
      isCheckpoint(parsed.createdAt) &&
      isCheckpoint(parsed.timelineSequence)
    ) {
      return {
        mode: parsed.mode,
        scope: parsed.scope,
        checkpoint: parsed.checkpoint,
        createdAt: parsed.createdAt,
        timelineSequence: parsed.timelineSequence,
      };
    }
    if (parsed.mode === "changes" && isCheckpoint(parsed.revision)) {
      return {
        mode: parsed.mode,
        scope: parsed.scope,
        checkpoint: parsed.checkpoint,
        revision: parsed.revision,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isCheckpoint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
  return eventResponseSchema.parse({
    id: event.id,
    type: event.type,
    data: JSON.parse(event.data) as unknown,
    messageId: event.message_id,
    createdAt: event.created_at,
  });
}

function clampHistoryLimit(limit: number | undefined): number {
  const rawLimit = typeof limit === "number" ? limit : DEFAULT_HISTORY_LIMIT;
  return Math.max(MIN_HISTORY_LIMIT, Math.min(rawLimit, MAX_HISTORY_LIMIT));
}
