import type { EventRow } from "./types";

export interface EventTimelineCursor {
  kind: "timeline";
  createdAt: number;
  id: string;
}

export interface LegacyEventCursor {
  kind: "legacy";
  createdAt: number;
}

export type EventListCursor = EventTimelineCursor | LegacyEventCursor;

export type ParseEventCursorResult<TCursor> =
  | { ok: true; cursor: TCursor | null }
  | { ok: false; error: string };

export function eventTimelineCursorFromRow(
  event: Pick<EventRow, "created_at" | "id">
): EventTimelineCursor {
  return { kind: "timeline", createdAt: event.created_at, id: event.id };
}

export function encodeEventTimelineCursor(cursor: EventTimelineCursor): string {
  return `${cursor.createdAt}:${encodeURIComponent(cursor.id)}`;
}

export function parseEventTimelineCursor(
  raw: string | null | undefined,
  fieldName = "cursor"
): ParseEventCursorResult<EventTimelineCursor> {
  if (!raw) return { ok: true, cursor: null };

  const cursor = decodeCompositeEventCursor(raw);
  return cursor ? { ok: true, cursor } : { ok: false, error: `Invalid ${fieldName}` };
}

export function parseEventListCursor(
  raw: string | null | undefined,
  fieldName = "cursor"
): ParseEventCursorResult<EventListCursor> {
  if (!raw) return { ok: true, cursor: null };

  const compositeCursor = decodeCompositeEventCursor(raw);
  if (compositeCursor) return { ok: true, cursor: compositeCursor };

  const legacyCreatedAt = Number(raw);
  if (Number.isSafeInteger(legacyCreatedAt) && legacyCreatedAt >= 0) {
    return { ok: true, cursor: { kind: "legacy", createdAt: legacyCreatedAt } };
  }

  return { ok: false, error: `Invalid ${fieldName}` };
}

function decodeCompositeEventCursor(raw: string): EventTimelineCursor | null {
  const separator = raw.indexOf(":");
  if (separator <= 0) return null;

  const createdAt = Number(raw.slice(0, separator));
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;

  try {
    const id = decodeURIComponent(raw.slice(separator + 1));
    return id ? { kind: "timeline", createdAt, id } : null;
  } catch {
    return null;
  }
}
