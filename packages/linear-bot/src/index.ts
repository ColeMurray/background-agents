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
  deleteOAuthToken,
  exchangeCodeForToken,
  getLinearReconnectUrl,
  verifyLinearWebhook,
} from "./utils/linear-client";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";
import {
  resolveAppName,
  userPreferencesRequestSchema,
  verifyInternalToken,
} from "@open-inspect/shared";
import { handleAgentSessionEvent, escapeHtml } from "./webhook-handler";
import {
  consumeOAuthState,
  getLinearAuthHealthResponse,
  getLinearAuthState,
  getTeamRepoMapping,
  getProjectRepoMapping,
  getTriggerConfig,
  getUserPreferences,
  isDuplicateEvent,
  setLinearAuthState,
  storeOAuthState,
} from "./kv-store";

// Re-export pure functions for existing test imports
export {
  resolveStaticRepo,
  extractModelFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";

const log = createLogger("handler");
const WEBHOOK_TIMESTAMP_MAX_SKEW_MS = 60 * 1000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function readNestedStringField(record: Record<string, unknown>, keys: string[]): string | null {
  let current: unknown = record;
  for (const key of keys) {
    if (!isObjectRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

export function buildOAuthSuccessHtml(appName: string, orgName: string): string {
  return `
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>${escapeHtml(appName)} Agent Installed!</h1>
          <p>Successfully connected to workspace: <strong>${escapeHtml(orgName)}</strong></p>
          <p>You can now @mention or assign the agent on Linear issues.</p>
        </body>
      </html>
    `;
}

function isAgentSessionWebhookPayload(payload: unknown): payload is AgentSessionWebhook {
  if (!isObjectRecord(payload)) return false;

  const type = readStringField(payload, "type");
  const action = readStringField(payload, "action");
  const organizationId = readStringField(payload, "organizationId");
  const webhookId = readStringField(payload, "webhookId");
  const agentSession = payload.agentSession;

  if (!type || !action || !organizationId || !isObjectRecord(agentSession) || !webhookId) {
    return false;
  }

  return typeof agentSession.id === "string";
}

function readOrganizationId(payload: Record<string, unknown>): string | null {
  return (
    readStringField(payload, "organizationId") ||
    readNestedStringField(payload, ["organization", "id"]) ||
    readNestedStringField(payload, ["data", "organizationId"]) ||
    readNestedStringField(payload, ["data", "organization", "id"])
  );
}

function isAuthHealthWebhook(eventType: string, action: string): boolean {
  return (
    (eventType === "OAuthApp" && action === "revoked") ||
    (eventType === "PermissionChange" && action === "teamAccessChanged")
  );
}

function isWebhookTimestampStale(timestamp: number, now: number): boolean {
  return Math.abs(now - timestamp) > WEBHOOK_TIMESTAMP_MAX_SKEW_MS;
}

function readPermissionChangeDetails(payload: Record<string, unknown>): {
  canAccessAllPublicTeams?: boolean;
  addedTeamIds?: string[];
  removedTeamIds?: string[];
} {
  const data = isObjectRecord(payload.data) ? payload.data : payload;
  return {
    canAccessAllPublicTeams: readBooleanField(data, "canAccessAllPublicTeams"),
    addedTeamIds: readStringArrayField(data, "addedTeamIds") ?? [],
    removedTeamIds: readStringArrayField(data, "removedTeamIds") ?? [],
  };
}

function latestConnectedAt(state: Awaited<ReturnType<typeof getLinearAuthState>>): number | null {
  const candidate = state?.installation?.lastConnectedAt;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

async function handleAuthHealthWebhook(params: {
  env: Env;
  payload: Record<string, unknown>;
  eventType: string;
  action: string;
  traceId: string;
  deliveryId: string;
  webhookTimestamp: number;
}) {
  const { env, payload, eventType, action, traceId, deliveryId, webhookTimestamp } = params;
  const orgId = readOrganizationId(payload);
  if (!orgId) {
    log.warn("webhook.invalid_payload", {
      trace_id: traceId,
      reason: "missing_organization_id",
      type: eventType,
      action,
    });
    return { error: "Invalid payload" as const, status: 400 };
  }

  if (await isDuplicateEvent(env, deliveryId)) {
    log.info("webhook.deduplicated", { trace_id: traceId, event_key: deliveryId });
    return { ok: true as const, skipped: true as const, reason: "duplicate" };
  }

  if (eventType === "OAuthApp") {
    const existing = await getLinearAuthState(env, orgId);
    const connectedAt = latestConnectedAt(existing);
    if (connectedAt !== null && webhookTimestamp < connectedAt) {
      log.info("webhook.linear_auth_health_skipped", {
        trace_id: traceId,
        org_id: orgId,
        type: eventType,
        action,
        reason: "revocation_older_than_connection",
      });
      return {
        ok: true as const,
        skipped: true as const,
        reason: "revocation_older_than_connection",
      };
    }

    await deleteOAuthToken(env, orgId);
    await setLinearAuthState(env, {
      orgId,
      status: "reauthorization_required",
      reason: "oauth_app_revoked",
      traceId,
      details: { eventType, eventAction: action },
    });
    log.info("webhook.linear_auth_health", {
      trace_id: traceId,
      org_id: orgId,
      type: eventType,
      action,
    });
    return { ok: true as const };
  }

  // Team-access changes are diagnostic only: the OAuth token stays valid, so the
  // workspace stays green. A sticky reauthorization_required state is cleared only
  // by a successful OAuth callback, never by a permission event.
  const permissionDetails = readPermissionChangeDetails(payload);
  const existing = await getLinearAuthState(env, orgId);
  const preserveExistingReauth = existing?.status === "reauthorization_required";
  await setLinearAuthState(env, {
    orgId,
    status: preserveExistingReauth ? "reauthorization_required" : "connected",
    reason: preserveExistingReauth ? existing.reason : "permission_change",
    traceId,
    details: {
      eventType,
      eventAction: action,
      canAccessAllPublicTeams: permissionDetails.canAccessAllPublicTeams,
      addedTeamIds: permissionDetails.addedTeamIds,
      removedTeamIds: permissionDetails.removedTeamIds,
    },
  });

  log.info("webhook.linear_auth_health", {
    trace_id: traceId,
    org_id: orgId,
    type: eventType,
    action,
    can_access_all_public_teams: permissionDetails.canAccessAllPublicTeams,
    added_team_ids: permissionDetails.addedTeamIds,
    removed_team_ids: permissionDetails.removedTeamIds,
  });
  return { ok: true as const };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({ status: "healthy", service: "open-inspect-linear-bot" });
});

// ─── OAuth Routes ────────────────────────────────────────────────────────────

app.get("/oauth/authorize", async (c) => {
  const state = await storeOAuthState(c.env, crypto.randomUUID());
  return c.redirect(buildOAuthAuthorizeUrl(c.env, state), 302);
});

app.get("/oauth/callback", async (c) => {
  const traceId = crypto.randomUUID();
  const state = c.req.query("state");
  if (!state || !(await consumeOAuthState(c.env, state))) {
    log.warn("oauth.callback_invalid_state", { trace_id: traceId });
    return c.text("Invalid OAuth state", 400);
  }

  const error = c.req.query("error");
  if (error) return c.text(`OAuth Error: ${error}`, 400);

  const code = c.req.query("code");
  if (!code) return c.text("Missing required OAuth parameters", 400);

  try {
    const { orgName } = await exchangeCodeForToken(c.env, code, traceId);
    return c.html(buildOAuthSuccessHtml(resolveAppName(c.env), orgName));
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

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    log.warn("webhook.invalid_payload", { trace_id: traceId, reason: "invalid_json" });
    return c.json({ error: "Invalid payload" }, 400);
  }
  if (!isObjectRecord(payload)) {
    log.warn("webhook.invalid_payload", { trace_id: traceId, reason: "payload_not_object" });
    return c.json({ error: "Invalid payload" }, 400);
  }

  const eventType = readStringField(payload, "type") ?? "unknown";
  const action = readStringField(payload, "action") ?? "unknown";
  const deliveryId = c.req.header("linear-delivery") ?? null;

  if (isAuthHealthWebhook(eventType, action)) {
    const webhookTimestamp = readNumberField(payload, "webhookTimestamp");
    if (webhookTimestamp === null) {
      log.warn("webhook.invalid_payload", {
        trace_id: traceId,
        reason: "missing_or_invalid_webhook_timestamp",
        type: eventType,
        action,
      });
      return c.json({ error: "Invalid payload" }, 400);
    }
    if (!deliveryId) {
      log.warn("webhook.invalid_payload", {
        trace_id: traceId,
        reason: "missing_linear_delivery_header",
        type: eventType,
        action,
      });
      return c.json({ error: "Missing Linear-Delivery header" }, 400);
    }
    if (isWebhookTimestampStale(webhookTimestamp, Date.now())) {
      log.warn("webhook.invalid_payload", {
        trace_id: traceId,
        reason: "stale_timestamp",
        type: eventType,
        action,
      });
      return c.json({ ok: true, skipped: true, reason: "stale_timestamp" });
    }
    const result = await handleAuthHealthWebhook({
      env: c.env,
      payload,
      eventType,
      action,
      traceId,
      deliveryId,
      webhookTimestamp,
    });
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json(result);
  }

  if (eventType === "AgentSessionEvent") {
    if (!isAgentSessionWebhookPayload(payload)) {
      log.warn("webhook.invalid_payload", {
        trace_id: traceId,
        reason: "invalid_agent_session_event_shape",
      });
      return c.json({ error: "Invalid payload" }, 400);
    }

    // Linear's `Linear-Delivery` header is a UUID v4 that uniquely identifies
    // each delivery. The `webhookId` field in the body is the registered-webhook
    // configuration ID and is constant across deliveries, so we must not dedup
    // on it. https://linear.app/developers/webhooks#webhook-payload-details
    if (!deliveryId) {
      log.warn("webhook.invalid_payload", {
        trace_id: traceId,
        reason: "missing_linear_delivery_header",
      });
      return c.json({ error: "Missing Linear-Delivery header" }, 400);
    }

    const isDuplicate = await isDuplicateEvent(c.env, deliveryId);
    if (isDuplicate) {
      log.info("webhook.deduplicated", { trace_id: traceId, event_key: deliveryId });
      return c.json({ ok: true, skipped: true, reason: "duplicate" });
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
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
  await c.env.LINEAR_KV.put("config:team-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/triggers", async (c) => {
  return c.json(await getTriggerConfig(c.env));
});

app.put("/config/triggers", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
  await c.env.LINEAR_KV.put("config:triggers", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/project-repos", async (c) => {
  return c.json(await getProjectRepoMapping(c.env));
});

app.get("/config/auth-health", async (c) => {
  return c.json(await getLinearAuthHealthResponse(c.env, getLinearReconnectUrl(c.env)));
});

app.put("/config/project-repos", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
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
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
  const parsedBody = userPreferencesRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) return c.json({ error: "invalid request body" }, 400);
  const body = parsedBody.data;
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
