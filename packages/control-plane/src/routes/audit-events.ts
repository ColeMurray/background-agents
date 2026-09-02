import { encodeAuditEventCursor, parseAuditEventCursor } from "../db/audit-event-cursor";
import { AuditEventStore, toAuditEvent } from "../db/audit-event-store";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  requirePermission,
  type RequestContext,
  type Route,
} from "./shared";

const DEFAULT_AUDIT_EVENT_LIMIT = 25;
const MAX_AUDIT_EVENT_LIMIT = 100;

function singleQueryValue(searchParams: URLSearchParams, name: string): string | null | Response {
  const values = searchParams.getAll(name);
  if (values.length > 1) return error(`Invalid ${name}`, 400);
  return values[0] ?? null;
}

async function handleListAuditEvents(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const rawLimit = singleQueryValue(searchParams, "limit");
  if (rawLimit instanceof Response) return rawLimit;
  const cursor = singleQueryValue(searchParams, "cursor");
  if (cursor instanceof Response) return cursor;

  if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) return error("Invalid limit", 400);
  const limit = rawLimit === null ? DEFAULT_AUDIT_EVENT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > MAX_AUDIT_EVENT_LIMIT) {
    return error("Invalid limit", 400);
  }
  const parsedCursor = parseAuditEventCursor(cursor);
  if (!parsedCursor.ok) return error(parsedCursor.error, 400);

  const result = await new AuditEventStore(ctx.db).list({ limit, cursor: parsedCursor.cursor });
  return json({
    events: result.rows.map(toAuditEvent),
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ? encodeAuditEventCursor(result.nextCursor) : null,
  });
}

export const auditEventRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    path: "/audit-events",
    authorization: requirePermission("workspace.audit.read", { service: "deny" }),
    cacheControl: "private, no-store",
    handler: handleListAuditEvents,
  },
]);
