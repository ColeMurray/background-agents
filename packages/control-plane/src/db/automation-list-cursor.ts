export interface AutomationListCursor {
  createdAt: number;
  id: string;
}

type ParseAutomationListCursorResult =
  | { ok: true; cursor: AutomationListCursor | null }
  | { ok: false; error: string };

export function encodeAutomationListCursor(cursor: AutomationListCursor): string {
  return `${cursor.createdAt}:${encodeURIComponent(cursor.id)}`;
}

export function parseAutomationListCursor(raw: string | null): ParseAutomationListCursorResult {
  if (!raw) return { ok: true, cursor: null };

  const separator = raw.indexOf(":");
  if (separator <= 0) return { ok: false, error: "Invalid cursor" };

  const createdAt = Number(raw.slice(0, separator));
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
