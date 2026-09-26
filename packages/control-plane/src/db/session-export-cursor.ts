import {
  encodeCreatedAtCursor,
  parseCreatedAtCursor,
  type CreatedAtCursor,
} from "../created-at-cursor";

export interface SessionExportCursor extends CreatedAtCursor {
  snapshotMaxRowId: number;
}

export interface RunsExportCursor extends SessionExportCursor {
  rootCreatedAt: number;
  rootSessionId: string;
  spawnDepth: number;
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

export function encodeRunsExportCursor(cursor: RunsExportCursor): string {
  return `r:${cursor.rootCreatedAt}:${encodeURIComponent(cursor.rootSessionId)}:${cursor.spawnDepth}:${encodeCreatedAtCursor(cursor)}:${cursor.snapshotMaxRowId}`;
}

export function parseRunsExportCursor(
  raw: string | null | undefined
): { ok: true; cursor: RunsExportCursor | null } | { ok: false; error: "Invalid cursor" } {
  if (raw === null || raw === undefined) return { ok: true, cursor: null };
  if (!raw.startsWith("r:")) return { ok: false, error: "Invalid cursor" };

  const fields = raw.slice(2).split(":");
  if (fields.length !== 6) return { ok: false, error: "Invalid cursor" };
  const [rootCreatedAtRaw, rootSessionIdRaw, spawnDepthRaw, createdAtRaw, idRaw, snapshotRaw] =
    fields;
  const numbers = [rootCreatedAtRaw, spawnDepthRaw, createdAtRaw, snapshotRaw];
  if (numbers.some((value) => !/^\d+$/.test(value))) {
    return { ok: false, error: "Invalid cursor" };
  }
  const values = numbers.map(Number);
  if (values.some((value) => !Number.isSafeInteger(value)) || values[3] < 1) {
    return { ok: false, error: "Invalid cursor" };
  }
  const [rootCreatedAt, spawnDepth, createdAt, snapshotMaxRowId] = values;

  try {
    const rootSessionId = decodeURIComponent(rootSessionIdRaw);
    const id = decodeURIComponent(idRaw);
    if (!rootSessionId || !id) return { ok: false, error: "Invalid cursor" };
    return {
      ok: true,
      cursor: { rootCreatedAt, rootSessionId, spawnDepth, createdAt, id, snapshotMaxRowId },
    };
  } catch {
    return { ok: false, error: "Invalid cursor" };
  }
}
