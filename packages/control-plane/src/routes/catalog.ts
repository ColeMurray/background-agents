/**
 * Canonical control-plane HTTP route catalog.
 *
 * Registration order is part of the routing contract for overlapping static
 * and parameterized paths.
 */

import type { RouteCatalogEntry } from "../routing/hono-env";
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
import { handleSlackNotify } from "./slack-notify";
import { signInProviderRoutes } from "./sign-in-providers";
import { skillRoutes } from "./skills";
import { defineRoute, GITHUB_SANDBOX_FALLBACK_ROUTE, requirePermission } from "./shared";

/**
 * Registration order is the precedence order. A Hono sub-app is mounted where
 * it appears; a legacy route is registered through the catalog adapter.
 */
export const catalog: RouteCatalogEntry[] = [
  healthRoutes,

  ...browserAuthRoutes,
  signInProviderRoutes,

  // Session management
  ...sessionRoutes,
  // Agent-initiated Slack notification (sandbox-authenticated)
  defineRoute(GITHUB_SANDBOX_FALLBACK_ROUTE, {
    method: "POST",
    path: "/sessions/:id/slack-notify",
    authorization: requirePermission("sessions.collaborate"),
    handler: handleSlackNotify,
  }),

  // Repository management
  ...reposRoutes,

  // Secrets
  ...secretsRoutes,

  // Environments (Phase-2 session target; internal-HMAC only, web BFF proxied)
  ...environmentRoutes,
  ...environmentSecretsRoutes,

  // Image builds (scope-generic)
  ...imageBuildRoutes,

  // Model preferences
  modelPreferencesRoutes,

  // Subscription provider account management and sandbox access broker
  ...modelProviderAccountRoutes,

  // Integration settings
  ...integrationSettingsRoutes,

  // Deployment-wide commit signing identity
  ...commitSigningRoutes,

  // SCM (source-control) settings
  ...scmSettingsRoutes,

  // Automations
  ...automationRoutes,

  // MCP servers
  ...mcpServerRoutes,

  // Analytics
  analyticsRoutes,

  // Workspace audit log
  auditEventRoutes,

  // Pull request feedback Autofix activity
  ...autofixRoutes,

  // Installation-wide managed skills and personal profiles
  ...skillRoutes,

  // Personal keyboard shortcuts
  keyboardShortcutRoutes,

  // Workspace roles, members, and current-user authorization
  ...rbacRoutes,

  // Webhooks (public routes — auth handled per-route)
  ...webhookRoutes,
];
