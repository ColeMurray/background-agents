import { parseCreatedAtCursor, type CreatedAtCursor } from "../created-at-cursor";

export type MessageListCursor = CreatedAtCursor | { createdAt: number; id?: never };

export function parseMessageListCursor(
  raw: string | null | undefined
): { ok: true; cursor: MessageListCursor | null } | { ok: false; error: "Invalid cursor" } {
  const composite = parseCreatedAtCursor(raw);
  if (composite.ok) return composite;

  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) {
    return { ok: false, error: "Invalid cursor" };
  }
  const createdAt = Number(raw);
  return Number.isSafeInteger(createdAt) && createdAt >= 0
    ? { ok: true, cursor: { createdAt } }
    : { ok: false, error: "Invalid cursor" };
}
