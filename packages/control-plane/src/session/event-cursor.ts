import type { EventRow } from "./types";

export interface EventTimelineCursor {
  kind: "timeline";
  createdAt: number;
  id: string;
  sequence?: number;
}

interface LegacyEventCursor {
  kind: "legacy";
  createdAt: number;
}

export type EventListCursor = EventTimelineCursor | LegacyEventCursor;

export type ParseEventCursorResult<TCursor> =
  | { ok: true; cursor: TCursor | null }
  | { ok: false; error: string };

export function eventTimelineCursorFromRow(
  event: Pick<EventRow, "created_at" | "id" | "timeline_sequence">
): EventTimelineCursor {
  return {
    kind: "timeline",
    createdAt: event.created_at,
    id: event.id,
    ...(event.timeline_sequence === undefined ? {} : { sequence: event.timeline_sequence }),
  };
}

export function encodeEventTimelineCursor(cursor: EventTimelineCursor): string {
  return cursor.sequence === undefined
    ? `${cursor.createdAt}:${encodeURIComponent(cursor.id)}`
    : `${cursor.createdAt}:${cursor.sequence}:${encodeURIComponent(cursor.id)}`;
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
    const remainder = raw.slice(separator + 1);
    const sequenceSeparator = remainder.indexOf(":");
    if (sequenceSeparator > 0) {
      const sequence = Number(remainder.slice(0, sequenceSeparator));
      const id = decodeURIComponent(remainder.slice(sequenceSeparator + 1));
      if (Number.isSafeInteger(sequence) && sequence >= 0 && id) {
        return { kind: "timeline", createdAt, sequence, id };
      }
    }
    const id = decodeURIComponent(remainder);
    return id ? { kind: "timeline", createdAt, id } : null;
  } catch {
    return null;
  }
}
