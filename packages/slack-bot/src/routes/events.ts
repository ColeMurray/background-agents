import { verifySlackSignature } from "@open-inspect/shared/slack";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { Hono } from "hono";
import { handleSlackEvent } from "../events/dispatcher";
import { slackEventPayloadSchema } from "../events/payload";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { admitSlackIngress, SLACK_INGRESS_QUEUE_VERSION } from "../ingress-authority";
import { processSlackIngressJob } from "../ingress-consumer";

const log = createLogger("handler");
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;
export const eventRoutes = new Hono<{ Bindings: Env }>();

eventRoutes.post("/events", async (c) => {
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
      http_path: "/events",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const parsedPayload = slackEventPayloadSchema.safeParse(parsedJson);
  if (!parsedPayload.success) return c.json({ error: "Invalid payload" }, 400);
  const payload = parsedPayload.data;
  if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });

  const eventId = payload.event_id;
  log.info("slack.ingress", {
    event: "slack.ingress",
    milestone: "ingress",
    source: "slack",
    timestamp_ms: startTime,
    trace_id: traceId,
    event_id: eventId,
    event_type: payload.event?.type,
  });
  const acknowledge = () => {
    const timestampMs = Date.now();
    log.info("slack.ingress", {
      event: "slack.ingress",
      milestone: "ack",
      source: "slack",
      timestamp_ms: timestampMs,
      duration_ms: timestampMs - startTime,
      trace_id: traceId,
      event_id: eventId,
      event_type: payload.event?.type,
    });
    return c.json({ ok: true });
  };

  const durableEnabled = c.env.PI_SLACK_DURABLE_INGRESS_ENABLED?.trim().toLowerCase() === "true";
  if (
    durableEnabled &&
    payload.type === "event_callback" &&
    payload.event_id &&
    payload.event?.channel
  ) {
    try {
      const admittedAt = Date.now();
      const admission = await admitSlackIngress(c.env, payload, body, admittedAt);
      log.info("slack.ingress", {
        event: "slack.ingress",
        milestone: "durable_ingress",
        source: "slack",
        event_id: payload.event_id,
        receipt_id: admission.receipt.id,
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - startTime,
      });
      if (admission.receipt.state !== "completed" && admission.receipt.state !== "failed") {
        if (!c.env.SLACK_INGRESS_QUEUE) throw new Error("Slack ingress Queue is unavailable");
        const job = {
          version: SLACK_INGRESS_QUEUE_VERSION,
          receiptId: admission.receipt.id,
          eventId: payload.event_id,
          admittedAt,
        };
        await c.env.SLACK_INGRESS_QUEUE.send(job, { contentType: "json" });
        c.executionCtx.waitUntil(processSlackIngressJob(c.env, job).then(() => undefined));
      }
      return acknowledge();
    } catch (error) {
      log.error("slack.ingress", {
        event: "slack.ingress",
        milestone: "durable_ingress",
        source: "slack",
        event_id: payload.event_id,
        timestamp_ms: Date.now(),
        outcome: "retry",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return c.json({ error: "Durable ingress unavailable" }, 503);
    }
  }

  if (eventId) {
    const cacheStore = createKvCacheStore(c.env.SLACK_KV);
    const dedupeKey = `event:${eventId}`;
    let kvOperation: "get" | "put" = "get";
    try {
      if (await cacheStore.get(dedupeKey)) {
        log.debug("slack.event.duplicate", { trace_id: traceId, event_id: eventId });
        return acknowledge();
      }
      kvOperation = "put";
      await cacheStore.put(dedupeKey, "1", { ttlMs: EVENT_DEDUPE_TTL_MS });
    } catch (error) {
      // This cache is best-effort. Returning 500 would drop the original work and guarantee retries.
      log.error("slack.event.dedupe_unavailable", {
        trace_id: traceId,
        event_id: eventId,
        event_type: payload.event?.type,
        kv_operation: kvOperation,
        slack_retry_num: c.req.header("x-slack-retry-num"),
        slack_retry_reason: c.req.header("x-slack-retry-reason"),
        outcome: "degraded",
        degradation_mode: "process_without_deduplication",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  const scheduleBackground = (promise: Promise<void>) => c.executionCtx.waitUntil(promise);
  const eventTask = Promise.resolve().then(() =>
    handleSlackEvent(payload, c.env, traceId, scheduleBackground)
  );
  c.executionCtx.waitUntil(eventTask);
  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/events",
    http_status: 200,
    event_id: eventId,
    event_type: payload.event?.type,
    duration_ms: Date.now() - startTime,
  });
  return acknowledge();
});
