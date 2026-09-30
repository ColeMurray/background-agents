/**
 * Generic automation webhook route — per-automation inbound HTTP endpoint.
 */

import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import { AutomationStore } from "../db/automation-store";
import { verifyWebhookApiKey } from "../auth/webhook-key";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RequestContext } from "../routes/shared";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
} from "../routes/shared";
import type { Env } from "../types";
import { Scheduler } from "../scheduler/scheduler";

/** Maximum webhook payload size (64KB). */
const MAX_PAYLOAD_SIZE = 64 * 1024;

export function parseWebhookIdempotencyKey(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("idempotencyKey" in body)) {
    return undefined;
  }

  return typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
}

async function authorizeWebhook(
  request: Request,
  ctx: RequestContext,
  automationId: string
): Promise<Response | AutomationStore> {
  const authHeader = request.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!apiKey) return error("Missing API key", 401);

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "webhook") return error("Not found", 404);
  if (!automation.trigger_auth_data) return error("Webhook not configured", 500);
  if (!(await verifyWebhookApiKey(apiKey, automation.trigger_auth_data))) {
    return error("Invalid API key", 401);
  }
  return store;
}

async function handleAutomationWebhook(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const automationId = params.id;

  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }

  const authorization = await authorizeWebhook(request, ctx, automationId);
  if (authorization instanceof Response) return authorization;

  // Reject oversized payloads before reading the body.
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }
  const bodyText = await request.text();
  if (bodyText.length > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return error("Invalid JSON body", 400);
  }

  const idempotencyKey = parseWebhookIdempotencyKey(body);

  const event = normalizeWebhookEvent(automationId, body, idempotencyKey);
  const result = await new Scheduler(ctx.db, env, ctx.executionCtx).event(event);
  return json({ ok: true, ...result });
}

async function handleWebhookInvocationStatus(
  request: Request,
  _env: Env,
  params: { id: string; invocationId: string },
  ctx: RequestContext
): Promise<Response> {
  const authorization = await authorizeWebhook(request, ctx, params.id);
  if (authorization instanceof Response) return authorization;

  const invocation = await authorization.getWebhookInvocationStatus(params.id, params.invocationId);
  if (!invocation) return error("Not found", 404);
  return json({ invocationId: params.invocationId, ...invocation });
}

export const automationWebhookRoutes = new Hono<ControlPlaneHonoEnv>();

automationWebhookRoutes.post(
  "/webhooks/automation/:id",
  admit({ ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleAutomationWebhook)
);

automationWebhookRoutes.get(
  "/webhooks/automation/:id/invocations/:invocationId",
  admit({ ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleWebhookInvocationStatus)
);
