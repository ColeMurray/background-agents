import { verifySlackSignature } from "@open-inspect/shared";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { Hono } from "hono";
import { z } from "zod";
import { handleSlackEvent, type SlackEventPayload } from "../events/dispatcher";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("handler");
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;
export const eventRoutes = new Hono<{ Bindings: Env }>();

const slackMessageFileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
  size: z.number().optional(),
  mode: z.string().optional(),
});

const slackMessageAttachmentSchema = z.object({
  is_share: z.boolean().optional(),
  is_msg_unfurl: z.boolean().optional(),
  text: z.string().optional(),
  fallback: z.string().optional(),
  author_name: z.string().optional(),
  channel_name: z.string().optional(),
  channel_id: z.string().optional(),
  ts: z.string().optional(),
  from_url: z.string().optional(),
  files: z.array(slackMessageFileSchema).optional(),
});

const slackEventPayloadSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  event_id: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      text: z.string().optional(),
      user: z.string().optional(),
      channel: z.string().optional(),
      ts: z.string().optional(),
      thread_ts: z.string().optional(),
      bot_id: z.string().optional(),
      tab: z.string().optional(),
      channel_type: z.string().optional(),
      subtype: z.string().optional(),
      files: z.array(slackMessageFileSchema).optional(),
      attachments: z.array(slackMessageAttachmentSchema).optional(),
    })
    .optional(),
}) satisfies z.ZodType<SlackEventPayload & { challenge?: string; event_id?: string }>;

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
  if (eventId) {
    const cacheStore = createKvCacheStore(c.env.SLACK_KV);
    const dedupeKey = `event:${eventId}`;
    let kvOperation: "get" | "put" = "get";
    try {
      if (await cacheStore.get(dedupeKey)) {
        log.debug("slack.event.duplicate", { trace_id: traceId, event_id: eventId });
        return c.json({ ok: true });
      }
      kvOperation = "put";
      await cacheStore.put(dedupeKey, "1", { expirationTtl: EVENT_DEDUPE_TTL_MS / 1000 });
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
  return c.json({ ok: true });
});
