/**
 * Open-Inspect Linear Agent Worker
 *
 * Cloudflare Worker handling Linear AgentSessionEvent webhooks.
 * Routes-only entry point — orchestration lives in webhook-handler.ts.
 */

import { Hono } from "hono";
import type { Env, UserPreferences, AgentSessionWebhook } from "./types";
import {
  buildOAuthAuthorizeUrl,
  exchangeCodeForToken,
  verifyLinearWebhook,
} from "./utils/linear-client";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";
import { verifyInternalToken } from "@open-inspect/shared";
import { handleAgentSessionEvent, escapeHtml } from "./webhook-handler";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getTriggerConfig,
  getUserPreferences,
  isDuplicateEvent,
} from "./kv-store";

// Re-export pure functions for existing test imports
export {
  resolveStaticRepo,
  extractModelFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";

const log = createLogger("handler");

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function isAgentSessionWebhookPayload(payload: unknown): payload is AgentSessionWebhook {
  if (!isObjectRecord(payload)) return false;

  const type = readStringField(payload, "type");
  const action = readStringField(payload, "action");
  const organizationId = readStringField(payload, "organizationId");
  const agentSession = payload.agentSession;

  if (!type || !action || !organizationId || !isObjectRecord(agentSession)) {
    return false;
  }

  return typeof agentSession.id === "string";
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({ status: "healthy", service: "open-inspect-linear-bot" });
});

// ─── OAuth Routes ────────────────────────────────────────────────────────────

app.get("/oauth/authorize", (c) => {
  return c.redirect(buildOAuthAuthorizeUrl(c.env), 302);
});

app.get("/oauth/callback", async (c) => {
  const error = c.req.query("error");
  if (error) return c.text(`OAuth Error: ${error}`, 400);

  const code = c.req.query("code");
  if (!code) return c.text("Missing required OAuth parameters", 400);

  try {
    const { orgName } = await exchangeCodeForToken(c.env, code);
    return c.html(`
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>Open-Inspect Agent Installed!</h1>
          <p>Successfully connected to workspace: <strong>${escapeHtml(orgName)}</strong></p>
          <p>You can now @mention or assign the agent on Linear issues.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("oauth.callback_error", { error: err instanceof Error ? err : new Error(msg) });
    return c.text(`Token exchange error: ${msg}`, 500);
  }
});

// ─── Webhook Handler ─────────────────────────────────────────────────────────

app.post("/webhook", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const signature = c.req.header("linear-signature") ?? null;

  const isValid = await verifyLinearWebhook(body, signature, c.env.LINEAR_WEBHOOK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/webhook",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload: unknown = JSON.parse(body);
  if (!isObjectRecord(payload)) {
    log.warn("webhook.invalid_payload", { trace_id: traceId, reason: "payload_not_object" });
    return c.json({ error: "Invalid payload" }, 400);
  }

  const eventType = readStringField(payload, "type") ?? "unknown";
  const action = readStringField(payload, "action") ?? "unknown";

  if (eventType === "AgentSessionEvent") {
    // Deduplicate: use agentSession.id + action as key
    const agentSession = isObjectRecord(payload.agentSession) ? payload.agentSession : undefined;
    if (agentSession) {
      const agentSessionId = readStringField(agentSession, "id");
      if (!agentSessionId) {
        log.warn("webhook.invalid_payload", {
          trace_id: traceId,
          reason: "missing_agent_session_id",
        });
        return c.json({ error: "Invalid payload" }, 400);
      }

      const eventKey = `${agentSessionId}:${action}`;
      const isDuplicate = await isDuplicateEvent(c.env, eventKey);
      if (isDuplicate) {
        log.info("webhook.deduplicated", { trace_id: traceId, event_key: eventKey });
        return c.json({ ok: true, skipped: true, reason: "duplicate" });
      }
    }

    if (!isAgentSessionWebhookPayload(payload)) {
      log.warn("webhook.invalid_payload", {
        trace_id: traceId,
        reason: "invalid_agent_session_event_shape",
      });
      return c.json({ error: "Invalid payload" }, 400);
    }

    c.executionCtx.waitUntil(handleAgentSessionEvent(payload, c.env, traceId));

    log.info("http.request", {
      trace_id: traceId,
      http_path: "/webhook",
      http_status: 200,
      type: eventType,
      action,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ ok: true });
  }

  log.debug("webhook.skipped", { trace_id: traceId, type: eventType, action });
  return c.json({ ok: true, skipped: true, reason: `unhandled event type: ${eventType}` });
});

// ─── Config Auth Middleware ───────────────────────────────────────────────────

app.use("/config/*", async (c, next) => {
  const secret = c.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) return c.json({ error: "Auth not configured" }, 500);
  const isValid = await verifyInternalToken(c.req.header("Authorization") ?? null, secret);
  if (!isValid) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ─── Config Endpoints ────────────────────────────────────────────────────────

app.get("/config/team-repos", async (c) => {
  return c.json(await getTeamRepoMapping(c.env));
});

app.put("/config/team-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:team-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/triggers", async (c) => {
  return c.json(await getTriggerConfig(c.env));
});

app.put("/config/triggers", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:triggers", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/project-repos", async (c) => {
  return c.json(await getProjectRepoMapping(c.env));
});

app.put("/config/project-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:project-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/user-prefs/:userId", async (c) => {
  const userId = c.req.param("userId");
  const prefs = await getUserPreferences(c.env, userId);
  if (!prefs) return c.json({ error: "not found" }, 404);
  return c.json(prefs);
});

app.put("/config/user-prefs/:userId", async (c) => {
  const userId = c.req.param("userId");
  const body = (await c.req.json()) as Partial<UserPreferences>;
  const prefs: UserPreferences = {
    userId,
    model: body.model || c.env.DEFAULT_MODEL,
    reasoningEffort: body.reasoningEffort,
    updatedAt: Date.now(),
  };
  await c.env.LINEAR_KV.put(`user_prefs:${userId}`, JSON.stringify(prefs));
  return c.json({ ok: true });
});

// Mount callbacks router
app.route("/callbacks", callbacksRouter);

export default app;
