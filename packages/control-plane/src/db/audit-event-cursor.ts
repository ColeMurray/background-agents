import { auditEventTimestampSchema } from "@open-inspect/shared/types/audit-events";

export interface AuditEventCursor {
  occurredAt: number;
  id: string;
}

type ParseAuditEventCursorResult =
  | { ok: true; cursor: AuditEventCursor | null }
  | { ok: false; error: "Invalid cursor" };

export function encodeAuditEventCursor(cursor: AuditEventCursor): string {
  return `${cursor.occurredAt}:${encodeURIComponent(cursor.id)}`;
}

export function parseAuditEventCursor(raw: string | null): ParseAuditEventCursorResult {
  if (raw === null) return { ok: true, cursor: null };

  const separator = raw.indexOf(":");
  if (separator <= 0) return { ok: false, error: "Invalid cursor" };

  const occurredAt = auditEventTimestampSchema.safeParse(Number(raw.slice(0, separator)));
  if (!occurredAt.success) return { ok: false, error: "Invalid cursor" };

  try {
    const id = decodeURIComponent(raw.slice(separator + 1));
    return id
      ? { ok: true, cursor: { occurredAt: occurredAt.data, id } }
      : { ok: false, error: "Invalid cursor" };
  } catch {
    return { ok: false, error: "Invalid cursor" };
  }
}
