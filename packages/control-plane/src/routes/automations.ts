/**
 * Automation routes: one module per responsibility, mounted in precedence order.
 */

import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { automationCrudRoutes } from "./automation-crud";
import { automationKeyRoutes } from "./automation-keys";
import { automationLifecycleRoutes } from "./automation-lifecycle";
import { automationListRoutes } from "./automation-list";
import { automationRunRoutes } from "./automation-runs";
import { automationSlackSettingsRoutes } from "./automation-slack-settings";

export const automationRoutes = new Hono<ControlPlaneHonoEnv>();
for (const module of [
  automationSlackSettingsRoutes,
  automationListRoutes,
  automationCrudRoutes,
  automationLifecycleRoutes,
  automationRunRoutes,
  automationKeyRoutes,
]) {
  automationRoutes.route("/", module);
}
