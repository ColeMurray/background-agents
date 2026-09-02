import { Hono } from "hono";
import { encodeAuditEventCursor, parseAuditEventCursor } from "../db/audit-event-cursor";
import { AuditEventStore, toAuditEvent } from "../db/audit-event-store";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { error, json, requirePermission, SCM_AGNOSTIC_HUMAN_USER_ROUTE } from "./shared";

const DEFAULT_AUDIT_EVENT_LIMIT = 25;
const MAX_AUDIT_EVENT_LIMIT = 100;

function singleQueryValue(searchParams: URLSearchParams, name: string): string | null | Response {
  const values = searchParams.getAll(name);
  if (values.length > 1) return error(`Invalid ${name}`, 400);
  return values[0] ?? null;
}

export const auditEventRoutes = new Hono<ControlPlaneHonoEnv>();

auditEventRoutes.get(
  "/audit-events",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("workspace.audit.read", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  async (c) => {
    const { request, ctx } = c.var.admitted;
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
);
