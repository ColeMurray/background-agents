export * from "../slack";
export {
  matchRoutingRules,
  MAX_SLACK_ROUTING_KEYWORD_LENGTH,
  MAX_SLACK_ROUTING_RULES,
  normalizeRoutingRules,
} from "../types/integrations";
export type {
  SlackGlobalConfig,
  SlackGlobalSettings,
  SlackMentionsPolicy,
  SlackRepoSettings,
  SlackRoutingRule,
  SlackRoutingTargetType,
} from "../types/integrations";
