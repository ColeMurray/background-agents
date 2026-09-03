import { Hono } from "hono";
import { z } from "zod";
import { encodeAuditEventCursor, parseAuditEventCursor } from "../db/audit-event-cursor";
import { AuditEventStore, toAuditEvent } from "../db/audit-event-store";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseQuery } from "./query";
import { json, requirePermission, SCM_AGNOSTIC_HUMAN_USER_ROUTE } from "./shared";

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
    const query = parseQuery(request, auditEventQuery);
    if (query instanceof Response) return query;

    const result = await new AuditEventStore(ctx.db).list(query);
    return json({
      events: result.rows.map(toAuditEvent),
      hasMore: result.hasMore,
      nextCursor: result.nextCursor ? encodeAuditEventCursor(result.nextCursor) : null,
    });
  }
);
