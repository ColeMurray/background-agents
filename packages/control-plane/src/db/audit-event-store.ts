import {
  auditEventSchema,
  type AuditEvent,
  type AuditEventListResponse,
} from "@open-inspect/shared/types/audit-events";
import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

const auditEventCursorSchema = z
  .object({
    occurredAt: z.number().int().nonnegative().safe(),
    id: z.string().min(1),
  })
  .strict();

type AuditEventCursor = z.infer<typeof auditEventCursorSchema>;

export interface AuditEventRow {
  id: string;
  occurred_at: number;
  request_id: string;
  principal_kind: string;
  actor_user_id_snapshot: string | null;
  actor_service_snapshot: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  target_user_id_snapshot: string | null;
  reason_code: string;
  operation_result: string;
  metadata_json: string;
}

export class InvalidAuditEventCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidAuditEventCursorError";
  }
}

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
  return `v1.${encodeBase64Url(JSON.stringify(cursor))}`;
}

export function parseAuditEventCursor(raw: string): AuditEventCursor {
  if (!/^v1\.[A-Za-z0-9_-]+$/.test(raw)) throw new InvalidAuditEventCursorError();
  try {
    const cursor = auditEventCursorSchema.parse(JSON.parse(decodeBase64Url(raw.slice(3))));
    if (encodeAuditEventCursor(cursor) !== raw) throw new InvalidAuditEventCursorError();
    return cursor;
  } catch {
    throw new InvalidAuditEventCursorError();
  }
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return auditEventSchema.parse({
    id: row.id,
    occurredAt: row.occurred_at,
    requestId: row.request_id,
    principalKind: row.principal_kind,
    actorUserIdSnapshot: row.actor_user_id_snapshot,
    actorServiceSnapshot: row.actor_service_snapshot,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    targetUserIdSnapshot: row.target_user_id_snapshot,
    reasonCode: row.reason_code,
    operationResult: row.operation_result,
    metadata: JSON.parse(row.metadata_json),
  });
}

/** Read-only D1 access for the workspace audit log. */
export class AuditEventStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(options: { limit: number; cursor?: string | null }): Promise<AuditEventListResponse> {
    const cursor = options.cursor ? parseAuditEventCursor(options.cursor) : null;
    const result = cursor
      ? await this.db
          .prepare(
            `SELECT * FROM authorization_audit_events
             WHERE occurred_at < ? OR (occurred_at = ? AND id < ?)
             ORDER BY occurred_at DESC, id DESC LIMIT ?`
          )
          .bind(cursor.occurredAt, cursor.occurredAt, cursor.id, options.limit + 1)
          .all<AuditEventRow>()
      : await this.db
          .prepare(
            `SELECT * FROM authorization_audit_events
             ORDER BY occurred_at DESC, id DESC LIMIT ?`
          )
          .bind(options.limit + 1)
          .all<AuditEventRow>();

    const rows = result.results ?? [];
    const hasMore = rows.length > options.limit;
    const events = (hasMore ? rows.slice(0, options.limit) : rows).map(toAuditEvent);
    if (!hasMore) return { events, hasMore: false, nextCursor: null };
    const last = events[events.length - 1];
    return {
      events,
      hasMore: true,
      nextCursor: encodeAuditEventCursor({ occurredAt: last.occurredAt, id: last.id }),
    };
  }
}
