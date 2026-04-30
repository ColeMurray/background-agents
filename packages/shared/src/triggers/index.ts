/**
 * Trigger-based automation system — barrel exports.
 */

// Core types
export type {
  AutomationEventSource,
  AutomationEvent,
  GitHubAutomationEvent,
  LinearAutomationEvent,
  SentryAutomationEvent,
  WebhookAutomationEvent,
  TriggerSourceDefinition,
} from "./types";
export { TRIGGER_TYPE_TO_SOURCE } from "./types";

// Condition system
export type {
  ConditionConfigMap,
  ConditionType,
  TriggerCondition,
  ConditionHandler,
  ConditionRegistry,
  JsonPathFilter,
  TriggerConfig,
} from "./conditions";
export { matchesConditions, validateConditions } from "./conditions";

// Registry
export { conditionRegistry, triggerSources } from "./registry";

// Glob utility
export { matchGlob } from "./glob";

// GitHub source module
export {
  githubSource,
  normalizeGitHubEvent,
  buildGitHubContextBlock,
  GITHUB_WEBHOOK_EVENT_CATALOG,
} from "./github";

// Sentry source module
export {
  sentrySource,
  sentryConditions,
  normalizeSentryEvent,
  buildSentryContextBlock,
  verifySentrySignature,
} from "./sentry";

// Webhook source module
export {
  webhookSource,
  webhookConditions,
  normalizeWebhookEvent,
  resolveJsonPath,
  evaluateJsonPathFilter,
  buildWebhookContextBlock,
} from "./webhook";
