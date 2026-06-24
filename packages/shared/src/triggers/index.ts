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
  SlackAutomationEvent,
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
  TextMatchValue,
  TriggerConfig,
} from "./conditions";
export { matchesConditions, validateConditions } from "./conditions";

// Registry
export { conditionRegistry, triggerSources } from "./registry";

// Glob utility
export { matchGlob } from "./glob";

// GitHub source module
export { githubSource, normalizeGitHubEvent, GITHUB_WEBHOOK_EVENT_CATALOG } from "./github";

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

// Slack source module
export {
  slackSource,
  normalizeSlackEvent,
  SLACK_TEXT_MAX_LENGTH,
  REGEX_PATTERN_MAX_LENGTH,
  ALLOWED_REGEX_FLAGS,
  DEFAULT_MAX_RUNS_PER_HOUR,
} from "./slack";
export type { SlackMessageInput, SlackChannelMeta } from "./slack";
