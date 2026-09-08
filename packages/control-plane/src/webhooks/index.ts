/**
 * Webhook route modules, mounted in precedence order.
 */

import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { sentryWebhookRoutes } from "./sentry";
import { automationWebhookRoutes } from "./automation-webhook";
import { githubAutomationEventRoutes } from "./github";
import { slackAutomationEventRoutes } from "./slack";

export const webhookRoutes = new Hono<ControlPlaneHonoEnv>();
for (const module of [
  sentryWebhookRoutes,
  automationWebhookRoutes,
  githubAutomationEventRoutes,
  slackAutomationEventRoutes,
]) {
  webhookRoutes.route("/", module);
}
