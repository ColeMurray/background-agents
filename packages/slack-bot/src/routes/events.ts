import { createKvCacheStore, verifySlackSignature } from "@open-inspect/shared";
import { Hono } from "hono";
import { handleSlackEvent, slackEventPayloadSchema } from "../events/dispatcher";
import { createLogger } from "../logger";
import type { Env } from "../types";

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
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsedPayload = slackEventPayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    return c.json({ error: "Invalid Slack event payload" }, 400);
  }
  const payload = parsedPayload.data;
  if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });

  const eventId = payload.event_id;
  if (eventId) {
    const cacheStore = createKvCacheStore(c.env.SLACK_KV);
    const dedupeKey = `event:${eventId}`;
    if (await cacheStore.get(dedupeKey)) {
      log.debug("slack.event.duplicate", { trace_id: traceId, event_id: eventId });
      return c.json({ ok: true });
    }
    await cacheStore.put(dedupeKey, "1", { expirationTtl: EVENT_DEDUPE_TTL_MS / 1000 });
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
  return c.json({ ok: true });
});
