/**
 * Trigger-based automation system — barrel exports.
 */

// Core types
export type {
  AutomationEventSource,
  AutomationEvent,
  GitHubAutomationEvent,
  GitHubPullRequestEventFacts,
  LinearAutomationEvent,
  SentryAutomationEvent,
  WebhookAutomationEvent,
  SlackAutomationEvent,
  TriggerSourceDefinition,
  AutomationTriggerType,
  ConditionConfigMap,
  ConditionType,
  TriggerCondition,
  JsonPathFilter,
  TextMatchValue,
  TriggerConfig,
} from "./types";
export {
  TRIGGER_TYPE_TO_SOURCE,
  automationEventSchema,
  githubAutomationEventSchema,
  linearAutomationEventSchema,
  sentryAutomationEventSchema,
  webhookAutomationEventSchema,
  slackAutomationEventSchema,
  triggerConfigSchema,
} from "./types";

// Condition system
export type { ConditionHandler, ConditionRegistry } from "./conditions";
export {
  dedupeConditionsBySemanticKey,
  getConditionSemanticKey,
  isGitHubConditionCompatible,
  matchesConditions,
  validateConditions,
} from "./conditions";

// Registry
export { conditionRegistry, triggerSources } from "./registry";

// Glob utility
export { matchGlob } from "./glob";

// GitHub source module
export {
  githubSource,
  githubConditions,
  normalizeGitHubEvent,
  DEFAULT_GITHUB_CONCLUSION,
  CHECK_SUITE_CONCLUSIONS,
  WORKFLOW_RUN_CONCLUSIONS,
  getGitHubConclusionOptions,
  GITHUB_WEBHOOK_EVENT_CATALOG,
  getGitHubEventConditionTypes,
  isGitHubConditionSupported,
} from "./github";

// Sentry source module
export {
  sentrySource,
  sentryConditions,
  normalizeSentryEvent,
  buildSentryContextBlock,
  buildSentryIssueWebhookContextBlock,
  buildSentryMetricContextBlock,
  verifySentrySignature,
} from "./sentry";
export type {
  SentryIssueAlertPayload,
  SentryIssueWebhookPayload,
  SentryMetricAlertPayload,
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
  buildSlackContextBlock,
  slackChannelLabel,
  SLACK_TEXT_MAX_LENGTH,
  REGEX_PATTERN_MAX_LENGTH,
  ALLOWED_REGEX_FLAGS,
} from "./slack";
export type { SlackMessageInput, SlackChannelMeta } from "./slack";
