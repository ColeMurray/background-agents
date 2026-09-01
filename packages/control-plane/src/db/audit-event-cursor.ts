import { auditEventTimestampSchema } from "@open-inspect/shared/types/audit-events";
import { z } from "zod";

const auditEventCursorSchema = z
  .object({
    occurredAt: auditEventTimestampSchema,
    id: z.string().min(1),
  })
  .strict();

export type AuditEventCursor = z.infer<typeof auditEventCursorSchema>;

type ParseAuditEventCursorResult =
  | { ok: true; cursor: AuditEventCursor | null }
  | { ok: false; error: "Invalid cursor" };

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeAuditEventCursor(cursor: AuditEventCursor): string {
  return `v1.${encodeBase64Url(JSON.stringify(auditEventCursorSchema.parse(cursor)))}`;
}

export function parseAuditEventCursor(raw: string | null): ParseAuditEventCursorResult {
  if (raw === null) return { ok: true, cursor: null };
  if (!/^v1\.[A-Za-z0-9_-]+$/.test(raw)) return { ok: false, error: "Invalid cursor" };

  try {
    const cursor = auditEventCursorSchema.parse(JSON.parse(decodeBase64Url(raw.slice(3))));
    return encodeAuditEventCursor(cursor) === raw
      ? { ok: true, cursor }
      : { ok: false, error: "Invalid cursor" };
  } catch {
    return { ok: false, error: "Invalid cursor" };
  }
}
