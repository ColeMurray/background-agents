export interface SessionInboxCursor {
  latestUpdatedAt: number;
  rootSessionId: string;
}

export function encodeSessionInboxCursor(cursor: SessionInboxCursor): string {
  return `${cursor.latestUpdatedAt}:${encodeURIComponent(cursor.rootSessionId)}`;
}

export function parseSessionInboxCursor(
  raw: string | null | undefined
): { ok: true; cursor: SessionInboxCursor | null } | { ok: false; error: "Invalid cursor" } {
  if (raw === null || raw === undefined) return { ok: true, cursor: null };

  const separator = raw.indexOf(":");
  if (separator <= 0) return { ok: false, error: "Invalid cursor" };
  const latestUpdatedAt = Number(raw.slice(0, separator));
  if (!Number.isSafeInteger(latestUpdatedAt) || latestUpdatedAt < 0) {
    return { ok: false, error: "Invalid cursor" };
  }

  try {
    const rootSessionId = decodeURIComponent(raw.slice(separator + 1));
    return rootSessionId
      ? { ok: true, cursor: { latestUpdatedAt, rootSessionId } }
      : { ok: false, error: "Invalid cursor" };
  } catch {
    return { ok: false, error: "Invalid cursor" };
  }
}
