/**
 * Marker.io webhook adapter for generic webhook automations.
 *
 * Marker cannot send the bearer token required by the generic endpoint, so
 * this route verifies Marker's HMAC and dispatches the same normalized event.
 */

import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared/auth";
import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import { Hono } from "hono";
import { z } from "zod";
import { AutomationStore } from "../db/automation-store";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RequestContext } from "../routes/shared";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
} from "../routes/shared";
import { Scheduler } from "../scheduler/scheduler";
import type { Env } from "../types";

const MAX_PAYLOAD_SIZE = 256 * 1024;
const SIGNATURE_PREFIX = "sha256=";
const markerPayloadIdentitySchema = z.object({
  type: z.string().optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
  data: z.object({ id: z.string().optional() }).optional(),
});

export async function verifyMarkerSignature(
  body: string,
  signature: string | null | undefined,
  secret: string
): Promise<boolean> {
  if (!signature?.startsWith(SIGNATURE_PREFIX)) return false;

  const digest = signature.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;

  return timingSafeEqual(await computeHmacHex(body, secret), digest);
}

export function parseMarkerIdempotencyKey(body: unknown): string | undefined {
  const parsed = markerPayloadIdentitySchema.safeParse(body);
  if (!parsed.success) return undefined;

  const { type, webhookId, webhookTimestamp, data } = parsed.data;
  if (type && data?.id) {
    return webhookTimestamp === undefined
      ? `marker:${type}:${data.id}`
      : `marker:${type}:${data.id}:${webhookTimestamp}`;
  }
  return webhookId && webhookTimestamp !== undefined
    ? `marker:${webhookId}:${webhookTimestamp}`
    : undefined;
}

async function handleMarkerWebhook(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(params.id);
  if (!automation || automation.trigger_type !== "webhook") {
    return error("Not found", 404);
  }

  // ponytail: this deployment is single-tenant; move the secret into each
  // automation record if one deployment ever accepts multiple Marker workspaces.
  const secret = env.MARKER_WEBHOOK_SECRET?.trim();
  if (!secret) return error("Marker webhook not configured", 503);

  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) return error("Invalid signature", 401);

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) return error("Payload too large", 413);

  const bodyText = await request.text();
  if (bodyText.length > MAX_PAYLOAD_SIZE) return error("Payload too large", 413);
  if (!(await verifyMarkerSignature(bodyText, signature, secret))) {
    return error("Invalid signature", 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return error("Invalid JSON body", 400);
  }

  const event = normalizeWebhookEvent(params.id, body, parseMarkerIdempotencyKey(body));
  const result = await new Scheduler(ctx.db, env, ctx.executionCtx).event(event);
  return json({ ok: true, ...result });
}

export const markerWebhookRoutes = new Hono<ControlPlaneHonoEnv>();

markerWebhookRoutes.post(
  "/webhooks/marker/:id",
  admit({ ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleMarkerWebhook)
);
