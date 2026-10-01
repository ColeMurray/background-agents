/**
 * Internal endpoint the control plane calls after an agent posts a top-level
 * `slack-notify` message. It records the message's thread as the session's
 * thread, so an `@mention` reply there continues that session instead of
 * starting a new one — the same mapping a Slack-started session gets.
 *
 * Signed with the in-body HMAC the other control-plane callbacks use. `kind`
 * separates it from those bodies, and `timestamp` bounds replay: a replayed
 * body could otherwise recreate a mapping after it expired.
 */

import { verifyCallbackFromControlPlane } from "@open-inspect/shared/auth";
import { SLACK_THREAD_BINDING_KIND } from "@open-inspect/shared/types/session-api";
import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../logger";
import { lookupThreadSession, storeThreadSession } from "../sessions/thread-session-store";
import { NO_REPOSITORY_TARGET_LABEL, NO_REPOSITORY_TARGET_VALUE } from "../targets";
import type { Env } from "../types";

const log = createLogger("thread-binding-route");

/** The control plane calls right after the post, so a fresh body is seconds old. */
const THREAD_BINDING_MAX_AGE_MS = 2 * 60 * 1000;

const threadBindingRequestSchema = z.object({
  kind: z.literal(SLACK_THREAD_BINDING_KIND),
  channel: z.string().min(1),
  threadTs: z.string().min(1),
  sessionId: z.string().min(1),
  /** Primary repository `owner/name`, or null for a session without one. */
  repoFullName: z.string().min(1).nullable(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  timestamp: z.number(),
  signature: z.string().min(1),
});

export const threadBindingRoutes = new Hono<{ Bindings: Env }>();

threadBindingRoutes.post("/internal/thread-binding", async (c) => {
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }

  const parsed = threadBindingRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.SERVICE_AUTH_SECRET) {
    return c.json({ error: "not configured" }, 500);
  }
  const fresh = Math.abs(Date.now() - parsed.data.timestamp) <= THREAD_BINDING_MAX_AGE_MS;
  // Verify the raw body: zod re-emits keys in schema order, and the HMAC
  // covers the JSON exactly as the control plane serialized it.
  const signed = payload as typeof parsed.data;
  if (!fresh || !(await verifyCallbackFromControlPlane(signed, c.env))) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/internal/thread-binding",
      http_status: 401,
      outcome: "rejected",
      reject_reason: fresh ? "invalid_signature" : "stale_timestamp",
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  const { channel, threadTs, sessionId, repoFullName, model, reasoningEffort } = parsed.data;

  // ponytail: read-then-write, KV has no compare-and-swap. A top-level post's
  // ts is brand new, so only a replay of the same binding can race it.
  const existing = await lookupThreadSession(c.env, channel, threadTs);
  if (!existing) {
    await storeThreadSession(c.env, channel, threadTs, {
      sessionId,
      repoId: repoFullName ?? NO_REPOSITORY_TARGET_VALUE,
      repoFullName: repoFullName ?? NO_REPOSITORY_TARGET_LABEL,
      model,
      reasoningEffort,
      createdAt: Date.now(),
      lastPromptTs: threadTs,
    });
  }

  log.info("http.request", {
    trace_id: traceId,
    http_path: "/internal/thread-binding",
    http_status: 200,
    channel,
    thread_ts: threadTs,
    session_id: sessionId,
    bound: !existing,
    existing_session_id: existing?.sessionId,
  });

  return c.json({ ok: true, bound: !existing });
});
