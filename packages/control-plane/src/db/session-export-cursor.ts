/**
 * Keyset cursor for the session-trace export stream.
 *
 * Sessions are exported ordered by (created_at ASC, id ASC); the cursor is
 * the last emitted session's position in that order. Same wire format as the
 * automation list cursor: `<createdAt>:<encodeURIComponent(id)>`.
 */
export interface SessionExportCursor {
  createdAt: number;
  id: string;
}

export function encodeSessionExportCursor(cursor: SessionExportCursor): string {
  return `${cursor.createdAt}:${encodeURIComponent(cursor.id)}`;
}

export function parseSessionExportCursor(
  raw: string | null | undefined
): { ok: true; cursor: SessionExportCursor | null } | { ok: false; error: "Invalid cursor" } {
  if (raw === null || raw === undefined) return { ok: true, cursor: null };

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
