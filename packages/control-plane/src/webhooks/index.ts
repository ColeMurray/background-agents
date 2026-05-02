/**
 * Webhook route exports.
 */

import type { Route } from "../routes/shared";
import { sentryWebhookRoute } from "./sentry";
import { automationWebhookRoute } from "./automation-webhook";
import { githubAutomationEventRoute } from "./github";

export const webhookRoutes: Route[] = [
  sentryWebhookRoute,
  automationWebhookRoute,
  githubAutomationEventRoute,
];
