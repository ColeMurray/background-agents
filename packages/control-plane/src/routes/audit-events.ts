import { Hono } from "hono";
import { z } from "zod";
import { encodeAuditEventCursor, parseAuditEventCursor } from "../db/audit-event-cursor";
import { AuditEventStore, toAuditEvent } from "../db/audit-event-store";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseQuery } from "./query";
import {
  json,
  type RequestContext,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
} from "./shared";
import type { Env } from "../types";

export const DEFAULT_AUDIT_EVENT_LIMIT = 25;
const MAX_AUDIT_EVENT_LIMIT = 100;

const auditEventQuery = z.object({
  limit: z
    .string({ error: "Invalid limit" })
    .regex(/^[1-9]\d*$/, { error: "Invalid limit" })
    .optional()
    .transform((raw) => (raw === undefined ? DEFAULT_AUDIT_EVENT_LIMIT : Number(raw)))
    .refine((limit) => Number.isSafeInteger(limit) && limit <= MAX_AUDIT_EVENT_LIMIT, {
      error: "Invalid limit",
    }),
  cursor: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const parsed = parseAuditEventCursor(raw ?? null);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: parsed.error });
        return z.NEVER;
      }
      return parsed.cursor;
    }),
});

async function handleListAuditEvents(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, auditEventQuery);
  if (query instanceof Response) return query;

  const result = await new AuditEventStore(ctx.db).list(query);
  return json({
    events: result.rows.map(toAuditEvent),
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ? encodeAuditEventCursor(result.nextCursor) : null,
  });
}

export const auditEventRoutes = new Hono<ControlPlaneHonoEnv>();

auditEventRoutes.get(
  "/audit-events",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("workspace.audit.read", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleListAuditEvents)
);
