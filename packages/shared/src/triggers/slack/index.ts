/**
 * Slack trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export type { SlackAutomationEvent } from "../types";
export { normalizeSlackEvent, SLACK_TEXT_MAX_LENGTH } from "./normalizer";
export type { SlackMessageInput, SlackChannelMeta } from "./normalizer";
export { slackConditions, REGEX_PATTERN_MAX_LENGTH, ALLOWED_REGEX_FLAGS } from "./conditions";

/** Default per-automation hourly run cap when none is configured (rate limit). */
export const DEFAULT_MAX_RUNS_PER_HOUR = 10;

export const slackSource: TriggerSourceDefinition = {
  source: "slack",
  triggerType: "slack_event",
  displayName: "Slack Message",
  description: "Trigger when a message is posted in a watched Slack channel",
  supportsEventTypes: false,
  eventTypes: [
    {
      eventType: "message.posted",
      displayName: "Message posted",
      description: "A message is posted in a watched channel",
    },
  ],
  supportedConditions: ["text_match", "slack_channel", "slack_actor"],
};
