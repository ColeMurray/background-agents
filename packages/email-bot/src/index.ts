import { Webhook } from "svix";
import { Hono } from "hono";
import type { AgentMailWebhookPayload, EmailRoute, EmailThreadSession, Env } from "./types";
import {
  eventKey,
  normalizeAgentMailMessage,
  parseRoutesConfig,
  resolveEmailRoute,
  threadKey,
} from "./routing";
import { buildFollowUpPrompt, buildInitialPrompt } from "./prompts";
import { createSession, makeThreadSession, sendPrompt } from "./control-plane";
import { markMessageProcessed } from "./agentmail";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";

const app = new Hono<{ Bindings: Env }>();

function requestIdFor(routeId: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${routeId.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${stamp}-${suffix}`;
}

function verifyAgentMailWebhook(
  env: Env,
  rawBody: string,
  headers: Headers
): AgentMailWebhookPayload {
  const secret = env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) throw new Error("AGENTMAIL_WEBHOOK_SECRET is not configured");

  const webhook = new Webhook(secret);
  return webhook.verify(rawBody, {
    "svix-id": headers.get("svix-id") || "",
    "svix-timestamp": headers.get("svix-timestamp") || "",
    "svix-signature": headers.get("svix-signature") || "",
  }) as AgentMailWebhookPayload;
}

async function isDuplicateEvent(env: Env, eventId: string): Promise<boolean> {
  const key = eventKey(eventId);
  const existing = await env.EMAIL_KV.get(key);
  if (existing) return true;
  await env.EMAIL_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 7 });
  return false;
}

async function getThreadSession(
  env: Env,
  inboxId: string,
  threadId: string
): Promise<EmailThreadSession | null> {
  const raw = await env.EMAIL_KV.get(threadKey(inboxId, threadId));
  return raw ? (JSON.parse(raw) as EmailThreadSession) : null;
}

async function putThreadSession(
  env: Env,
  inboxId: string,
  threadId: string,
  data: EmailThreadSession
) {
  await env.EMAIL_KV.put(threadKey(inboxId, threadId), JSON.stringify(data));
}

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-email-bot" }));

app.post("/webhooks/agentmail", async (c) => {
  const traceId = crypto.randomUUID();
  const log = createLogger("agentmail-webhook", c.env.LOG_LEVEL);
  const rawBody = await c.req.text();

  let payload: AgentMailWebhookPayload;
  try {
    payload = verifyAgentMailWebhook(c.env, rawBody, c.req.raw.headers);
  } catch (error) {
    log.warn("webhook.rejected", {
      trace_id: traceId,
      reason: "invalid_signature",
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "invalid signature" }, 401);
  }

  const eventType = payload.event_type || payload.eventType || "";
  const eventId = payload.event_id || payload.eventId || crypto.randomUUID();

  if (eventType !== "message.received") {
    log.debug("webhook.skipped", { trace_id: traceId, event_type: eventType });
    return c.json({ ok: true, skipped: true, reason: "unsupported_event_type" });
  }

  if (await isDuplicateEvent(c.env, eventId)) {
    log.info("webhook.deduplicated", { trace_id: traceId, event_id: eventId });
    return c.json({ ok: true, skipped: true, reason: "duplicate" });
  }

  let message;
  try {
    message = normalizeAgentMailMessage(payload);
  } catch (error) {
    log.warn("webhook.invalid_message", {
      trace_id: traceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "invalid message payload" }, 400);
  }

  const routes = parseRoutesConfig(c.env.EMAIL_ROUTES_JSON);
  const resolution = resolveEmailRoute(routes, message);
  if (!resolution.ok) {
    log.warn("webhook.route_skipped", {
      trace_id: traceId,
      reason: resolution.reason,
      inbox_id: message.inboxId,
      thread_id: message.threadId,
      sender: message.senderEmail,
      matches: resolution.matches?.map((route) => route.id),
    });
    return c.json({ ok: true, skipped: true, reason: resolution.reason });
  }

  c.executionCtx.waitUntil(
    handleMessage({
      env: c.env,
      route: resolution.route,
      message,
      traceId,
    })
  );

  return c.json({ ok: true });
});

app.route("/callbacks", callbacksRouter);

async function handleMessage(params: {
  env: Env;
  route: EmailRoute;
  message: ReturnType<typeof normalizeAgentMailMessage>;
  traceId: string;
}): Promise<void> {
  const { env, route, message, traceId } = params;
  const log = createLogger("message-handler", env.LOG_LEVEL);
  const existing = await getThreadSession(env, message.inboxId, message.threadId);

  try {
    if (existing) {
      const prompt = buildFollowUpPrompt({ threadSession: existing, message });
      await sendPrompt({
        env,
        sessionId: existing.sessionId,
        route,
        message,
        requestId: existing.requestId,
        content: prompt,
        traceId,
      });
      await putThreadSession(env, message.inboxId, message.threadId, {
        ...existing,
        updatedAt: Date.now(),
      });
      await markMessageProcessed({
        env,
        inboxId: message.inboxId,
        messageId: message.messageId,
      }).catch((error) =>
        log.warn("message.label_update_failed", {
          trace_id: traceId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }

    const requestId = requestIdFor(route.id);
    const title = `${requestId} ${message.subject || route.id}`.trim();
    const sessionId = await createSession({
      env,
      route,
      title,
      actorEmail: message.senderEmail,
      traceId,
    });
    const threadSession = makeThreadSession({ sessionId, route, requestId, env });
    await putThreadSession(env, message.inboxId, message.threadId, threadSession);

    const prompt = buildInitialPrompt({ requestId, route, message });
    await sendPrompt({
      env,
      sessionId,
      route,
      message,
      requestId,
      content: prompt,
      traceId,
    });
    await markMessageProcessed({
      env,
      inboxId: message.inboxId,
      messageId: message.messageId,
    }).catch((error) =>
      log.warn("message.label_update_failed", {
        trace_id: traceId,
        error: error instanceof Error ? error.message : String(error),
      })
    );

    log.info("message.session_started", {
      trace_id: traceId,
      request_id: requestId,
      session_id: sessionId,
      route_id: route.id,
      sender: message.senderEmail,
    });
  } catch (error) {
    log.error("message.handle_failed", {
      trace_id: traceId,
      route_id: route.id,
      sender: message.senderEmail,
      thread_id: message.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default app;
