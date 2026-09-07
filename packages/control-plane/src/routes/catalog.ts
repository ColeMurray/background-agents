/**
 * Canonical control-plane HTTP route catalog.
 *
 * Registration order is part of the routing contract for overlapping static
 * and parameterized paths.
 */

import type { RouteModule } from "../routing/hono-env";
import { webhookRoutes } from "../webhooks";
import { analyticsRoutes } from "./analytics";
import { auditEventRoutes } from "./audit-events";
import { autofixRoutes } from "./autofix";
import { automationRoutes } from "./automations";
import { browserAuthRoutes } from "./browser-auth";
import { commitSigningRoutes } from "./commit-signing";
import { environmentSecretsRoutes } from "./environment-secrets";
import { environmentRoutes } from "./environments";
import { healthRoutes } from "./health";
import { imageBuildRoutes } from "./image-builds";
import { integrationSettingsRoutes } from "./integration-settings";
import { keyboardShortcutRoutes } from "./keyboard-shortcuts";
import { mcpServerRoutes } from "./mcp-servers";
import { modelPreferencesRoutes } from "./model-preferences";
import { modelProviderAccountRoutes } from "./model-provider-accounts";
import { rbacRoutes } from "./rbac";
import { reposRoutes } from "./repos";
import { scmSettingsRoutes } from "./scm-settings";
import { secretsRoutes } from "./secrets";
import { sessionRoutes } from "./sessions";
import { slackNotifyRoutes } from "./slack-notify";
import { signInProviderRoutes } from "./sign-in-providers";
import { skillRoutes } from "./skills";

/** Registration order is the precedence order: each module is mounted where it appears. */
export const catalog: readonly RouteModule[] = [
  healthRoutes,

  browserAuthRoutes,
  signInProviderRoutes,

  // Session management, then the agent-initiated Slack notification
  sessionRoutes,
  slackNotifyRoutes,

  // Repository management
  reposRoutes,

  // Secrets
  secretsRoutes,

  // Environments (Phase-2 session target; internal-HMAC only, web BFF proxied)
  environmentRoutes,
  environmentSecretsRoutes,

  // Image builds (scope-generic)
  imageBuildRoutes,

  // Model preferences
  modelPreferencesRoutes,

  // Subscription provider account management and sandbox access broker
  modelProviderAccountRoutes,

  // Integration settings
  integrationSettingsRoutes,

  // Deployment-wide commit signing identity
  commitSigningRoutes,

  // SCM (source-control) settings
  scmSettingsRoutes,

  // Automations
  automationRoutes,

  // MCP servers
  mcpServerRoutes,

  // Analytics
  analyticsRoutes,

  // Workspace audit log
  auditEventRoutes,

  // Pull request feedback Autofix activity
  autofixRoutes,

  // Installation-wide managed skills and personal profiles
  skillRoutes,

  // Personal keyboard shortcuts
  keyboardShortcutRoutes,

  // Workspace roles, members, and current-user authorization
  rbacRoutes,

  // Webhooks (public routes — auth handled per-route)
  webhookRoutes,
];
