/**
 * Generic automation webhook route — per-automation inbound HTTP endpoint.
 */

import type {
  AutomationInvocation,
  WebhookInvocationStatusResponse,
  WebhookTriggerResponse,
} from "@open-inspect/shared";
import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import { AutomationStore, type AutomationRow } from "../db/automation-store";
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

type WebhookAuthentication =
  | { ok: true; automation: AutomationRow }
  | { ok: false; response: Response };

/** Resolve the webhook automation and verify the request's Bearer key against it. */
async function authenticateWebhook(
  request: Request,
  store: AutomationStore,
  automationId: string
): Promise<WebhookAuthentication> {
  const authHeader = request.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!apiKey) return { ok: false, response: error("Missing API key", 401) };

  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "webhook") {
    return { ok: false, response: error("Not found", 404) };
  }
  if (!automation.trigger_auth_data) {
    return { ok: false, response: error("Webhook not configured", 500) };
  }
  if (!(await verifyWebhookApiKey(apiKey, automation.trigger_auth_data))) {
    return { ok: false, response: error("Invalid API key", 401) };
  }
  return { ok: true, automation };
}

async function handleAutomationWebhook(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const automationId = params.id;

  // 1. Validate content type
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }

  // 2. Authenticate the webhook key
  const auth = await authenticateWebhook(request, new AutomationStore(ctx.db), automationId);
  if (!auth.ok) return auth.response;

  // 3. Parse body — fast-path reject on Content-Length before reading
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

  // 4. Normalize and process the event. A webhook event targets exactly one
  // automation, so it has at most one invocation.
  const event = normalizeWebhookEvent(automationId, body, idempotencyKey);
  const { invocationIds, ...counts } = await new Scheduler(ctx.db, env, ctx.executionCtx).event(
    event
  );
  return json({
    ok: true,
    ...counts,
    invocationId: invocationIds[0] ?? null,
  } satisfies WebhookTriggerResponse);
}

async function handleWebhookInvocationStatus(
  request: Request,
  _env: Env,
  params: { id: string; invocationId: string },
  ctx: RequestContext
): Promise<Response> {
  const store = new AutomationStore(ctx.db);
  const auth = await authenticateWebhook(request, store, params.id);
  if (!auth.ok) return auth.response;

  const invocation = await store.getInvocation(auth.automation.id, params.invocationId);
  // The webhook key reads only the firings it caused — not manual or scheduled ones.
  if (!invocation || invocation.source !== "event") return error("Not found", 404);
  return json(toWebhookInvocationStatus(invocation));
}

/** Status only: the webhook key never exposes session content or other history. */
function toWebhookInvocationStatus(
  invocation: AutomationInvocation
): WebhookInvocationStatusResponse {
  return {
    invocationId: invocation.id,
    status: invocation.status,
    runs: invocation.runs.map(({ id, status, sessionId }) => ({ id, status, sessionId })),
  };
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
