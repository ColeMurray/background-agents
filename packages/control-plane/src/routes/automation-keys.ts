/**
 * Automation webhook key and Sentry secret regeneration route.
 */

import { sentryClientSecretSchema } from "@open-inspect/shared/types/automations";
import { AutomationStore } from "../db/automation-store";
import { generateWebhookApiKey, hashApiKey, encryptSentrySecret } from "../auth/webhook-key";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { type RequestContext, json, error } from "./shared";
import { parseBody } from "./body";
import type { Env } from "../types";
import { z } from "zod";
import { createLogger } from "../logger";
import { AUTOMATION_MANAGE_POLICY, admittedAutomation } from "./automation-shared";

const logger = createLogger("router:automations");

const regenerateSentrySecretBodySchema = z.object({
  sentryClientSecret: sentryClientSecretSchema,
});

async function handleRegenerateKey(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new AutomationStore(ctx.db);
  const { automation } = admittedAutomation(ctx);

  const workerUrl = env.WORKER_URL || "";

  if (automation.trigger_type === "sentry") {
    // Sentry: user provides a new client secret
    const body = await parseBody(
      request,
      regenerateSentrySecretBodySchema,
      "sentryClientSecret is required"
    );
    if (body instanceof Response) return body;
    if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
      return error("Encryption key not configured", 503);
    }
    const encrypted = await encryptSentrySecret(
      body.sentryClientSecret,
      env.REPO_SECRETS_ENCRYPTION_KEY
    );
    const statement = store.bindAutomationUpdate(id, {
      trigger_auth_data: encrypted,
    } as Record<string, unknown>);
    if (!statement) return error("Automation not found", 404);
    const result = await ctx.db.batch([statement]);
    if ((result[0]?.meta.changes ?? 0) === 0) return error("Automation not found", 404);

    logger.info("automation.secret_updated", {
      event: "automation.secret_updated",
      automation_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      sentryWebhookUrl: `${workerUrl}/webhooks/sentry/${id}`,
    });
  }

  if (automation.trigger_type !== "webhook") {
    return error("Only webhook and sentry automations support key regeneration", 400);
  }

  // Webhook: generate a new API key
  const apiKey = generateWebhookApiKey();
  const hash = await hashApiKey(apiKey);

  const statement = store.bindAutomationUpdate(id, {
    trigger_auth_data: hash,
  } as Record<string, unknown>);
  if (!statement) return error("Automation not found", 404);
  const result = await ctx.db.batch([statement]);
  if ((result[0]?.meta.changes ?? 0) === 0) return error("Automation not found", 404);

  logger.info("automation.key_regenerated", {
    event: "automation.key_regenerated",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({
    webhookApiKey: apiKey,
    webhookUrl: `${workerUrl}/webhooks/automation/${id}`,
  });
}

export const automationKeyRoutes = new Hono<ControlPlaneHonoEnv>();

// The response carries the only copy of a freshly minted webhook key.
automationKeyRoutes.post(
  "/automations/:id/regenerate-key",
  admit({ ...AUTOMATION_MANAGE_POLICY, cacheControl: "no-store" }),
  (c) => dispatch(c, handleRegenerateKey)
);
