import { verifySlackSignature } from "@open-inspect/shared";
import { Hono } from "hono";
import { handleAppHomeInteractionRoute } from "../app-home";
import { handleSlackInteraction } from "../interactions/dispatcher";
import { slackInteractionPayloadSchema } from "../interaction-payload";
import { createLogger } from "../logger";
import {
  SELECT_TARGET_ACTION_ID,
  countClarificationOptions,
  getTargetClarificationOptions,
} from "../target-clarification";
import type { Env } from "../types";

const log = createLogger("handler");
export const interactionRoutes = new Hono<{ Bindings: Env }>();

interactionRoutes.post("/interactions", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const isValid = await verifySlackSignature(
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
    c.env.SLACK_SIGNING_SECRET
  );
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payloadStr = new URLSearchParams(body).get("payload") || "{}";
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const parsedPayload = slackInteractionPayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) return c.json({ error: "Invalid payload" }, 400);
  const payload = parsedPayload.data;
  const scheduleBackground = (promise: Promise<void>) => c.executionCtx.waitUntil(promise);
  const appHomeResponse = await handleAppHomeInteractionRoute(
    payload,
    c.env,
    traceId,
    scheduleBackground
  );
  if (appHomeResponse) {
    log.info("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 200,
      ...appHomeResponse.logContext,
      duration_ms: Date.now() - startTime,
    });
    return c.json(appHomeResponse.body);
  }
  if (payload.type === "block_suggestion") {
    const response =
      payload.action_id === SELECT_TARGET_ACTION_ID
        ? await getTargetClarificationOptions(c.env, payload.value, traceId).catch(
            (e): { options: [] } => {
              log.error("slack.target_clarification_options", {
                trace_id: traceId,
                query: payload.value,
                error: e instanceof Error ? e : new Error(String(e)),
                duration_ms: Date.now() - startTime,
              });
              return { options: [] };
            }
          )
        : { options: [] };
    log.info("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 200,
      interaction_type: payload.type,
      action_id: payload.action_id,
      option_count: countClarificationOptions(response),
      duration_ms: Date.now() - startTime,
    });
    return c.json(response);
  }

  const actionId = payload.actions?.[0]?.action_id ?? payload.action_id;
  const interactionTask = Promise.resolve().then(() =>
    handleSlackInteraction(payload, c.env, traceId, scheduleBackground)
  );
  c.executionCtx.waitUntil(interactionTask);
  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/interactions",
    http_status: 200,
    interaction_type: payload.type,
    action_id: actionId,
    callback_id: payload.view?.callback_id,
    duration_ms: Date.now() - startTime,
  });
  return c.json({ ok: true });
});
