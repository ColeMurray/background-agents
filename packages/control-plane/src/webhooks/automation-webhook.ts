/**
 * Generic automation webhook route — per-automation inbound HTTP endpoint.
 */

import type {
  AutomationInvocation,
  WebhookFollowUpRefusedResponse,
  WebhookInvocationStatusResponse,
  WebhookTriggerResponse,
} from "@open-inspect/shared";
import { z } from "zod";
import {
  normalizeWebhookEvent,
  WEBHOOK_SESSION_KEY_MAX_LENGTH,
  webhookSessionKeySchema,
  type WebhookDeliveryOptions,
} from "@open-inspect/shared/triggers";
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
import { createScheduler } from "../scheduler/factory";
import { SessionFollowUpRefusedError } from "../scheduler/contracts";

/** Maximum webhook payload size (64KB). */
const MAX_PAYLOAD_SIZE = 64 * 1024;

const webhookDeliveryFieldsSchema = z.object({
  idempotencyKey: z.string().optional().catch(undefined),
  sessionKey: webhookSessionKeySchema.optional(),
});

type ParsedWebhookDeliveryFields =
  { ok: true; fields: WebhookDeliveryOptions } | { ok: false; error: string };

/** Read the delivery fields a webhook body may carry; a non-string idempotencyKey is ignored. */
export function parseWebhookDeliveryFields(body: unknown): ParsedWebhookDeliveryFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: true, fields: {} };

  const parsed = webhookDeliveryFieldsSchema.safeParse(body);
  return parsed.success
    ? { ok: true, fields: parsed.data }
    : {
        ok: false,
        error: `sessionKey must be a non-empty string of at most ${WEBHOOK_SESSION_KEY_MAX_LENGTH} characters`,
      };
}

/**
 * The sender sees a follow-up its session would not take, rather than the delivery
 * starting over in a fresh session: 409 when the session cannot take prompts, 429 when
 * its queue is full, 503 when it could not be reached or failed, which is safe to retry
 * with the same idempotencyKey, and 422 for any other refusal, which a retry repeats.
 */
export function followUpRefusedResponse(refusal: SessionFollowUpRefusedError): Response {
  const status =
    refusal.status === 409 || refusal.status === 429
      ? refusal.status
      : refusal.status === null || refusal.status >= 500
        ? 503
        : 422;
  return json(
    {
      error: refusal.message,
      code: refusal.code ?? (status === 503 ? "SESSION_UNAVAILABLE" : "FOLLOW_UP_REJECTED"),
      invocationId: refusal.invocationId,
    } satisfies WebhookFollowUpRefusedResponse,
    status
  );
}

type WebhookAuthentication =
  { ok: true; automation: AutomationRow } | { ok: false; response: Response };

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

  const delivery = parseWebhookDeliveryFields(body);
  if (!delivery.ok) {
    return error(delivery.error, 400);
  }

  // 4. Normalize and process the event. A webhook event targets exactly one
  // automation, so it has at most one invocation.
  const event = normalizeWebhookEvent(automationId, body, delivery.fields);
  let result;
  try {
    result = await createScheduler(ctx.db, env, ctx.executionCtx).event(event);
  } catch (e) {
    if (e instanceof SessionFollowUpRefusedError) return followUpRefusedResponse(e);
    throw e;
  }
  const { invocationIds, ...counts } = result;
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
  admit({
    ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
    authorization: NO_AUTHORIZATION,
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleWebhookInvocationStatus)
);
