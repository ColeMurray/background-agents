export interface CreatedAtCursor {
  createdAt: number;
  id: string;
}

export type ParseCreatedAtCursorResult =
  | { ok: true; cursor: CreatedAtCursor | null }
  | { ok: false; error: "Invalid cursor" };

export function encodeCreatedAtCursor(cursor: CreatedAtCursor): string {
  return `${cursor.createdAt}:${encodeURIComponent(cursor.id)}`;
}

export function parseCreatedAtCursor(raw: string | null | undefined): ParseCreatedAtCursorResult {
  if (raw === null || raw === undefined) return { ok: true, cursor: null };

  const separator = raw.indexOf(":");
  if (separator <= 0) return { ok: false, error: "Invalid cursor" };

  const createdAtRaw = raw.slice(0, separator);
  if (!/^\d+$/.test(createdAtRaw)) return { ok: false, error: "Invalid cursor" };

  const createdAt = Number(createdAtRaw);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    return { ok: false, error: "Invalid cursor" };
  }

  try {
    const id = decodeURIComponent(raw.slice(separator + 1));
    return id ? { ok: true, cursor: { createdAt, id } } : { ok: false, error: "Invalid cursor" };
  } catch {
    return { ok: false, error: "Invalid cursor" };
  }
}
