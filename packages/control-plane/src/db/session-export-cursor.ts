import {
  encodeCreatedAtCursor,
  parseCreatedAtCursor,
  type CreatedAtCursor,
} from "../created-at-cursor";

export interface SessionExportCursor extends CreatedAtCursor {
  snapshotMaxRowId: number;
}

export type ParseSessionExportCursorResult =
  | { ok: true; cursor: SessionExportCursor | null }
  | { ok: false; error: "Invalid cursor" };

export function encodeSessionExportCursor(cursor: SessionExportCursor): string {
  return `${encodeCreatedAtCursor(cursor)}:${cursor.snapshotMaxRowId}`;
}

export function parseSessionExportCursor(
  raw: string | null | undefined
): ParseSessionExportCursorResult {
  if (raw === null || raw === undefined) return { ok: true, cursor: null };

  const separator = raw.lastIndexOf(":");
  if (separator <= 0) return { ok: false, error: "Invalid cursor" };

  const base = parseCreatedAtCursor(raw.slice(0, separator));
  const snapshotRaw = raw.slice(separator + 1);
  if (!base.ok || !base.cursor || !/^\d+$/.test(snapshotRaw)) {
    return { ok: false, error: "Invalid cursor" };
  }

  const snapshotMaxRowId = Number(snapshotRaw);
  if (!Number.isSafeInteger(snapshotMaxRowId) || snapshotMaxRowId < 1) {
    return { ok: false, error: "Invalid cursor" };
  }

  return { ok: true, cursor: { ...base.cursor, snapshotMaxRowId } };
}
