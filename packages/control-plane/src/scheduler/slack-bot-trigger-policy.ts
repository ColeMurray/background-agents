import type { TriggerConfig } from "@open-inspect/shared/triggers";
import type { AutomationStore } from "../db/automation-store";

/**
 * Most runs that bot messages may start for one automation within
 * SLACK_BOT_TRIGGER_WINDOW_MS. A run's output can prompt another bot to post in
 * the watched channel, so an automation that accepts bot messages could
 * otherwise trigger itself indefinitely.
 *
 * The count is read before the firing is inserted, so a burst of simultaneous
 * bot messages can overshoot it. A loop cannot: each of its firings follows the
 * previous run, which is already counted.
 */
export const SLACK_BOT_TRIGGER_LIMIT = 10;
export const SLACK_BOT_TRIGGER_WINDOW_MS = 60 * 60 * 1000;
export const SLACK_BOT_TRIGGER_LIMIT_SKIP_REASON = "slack_bot_trigger_limit";

/**
 * Matches the trigger metadata of a firing a bot's message started: the Slack
 * event handler serializes SlackRunMetadata with JSON.stringify, which writes
 * this key only when `botId` is set. A LIKE stays within portable SQL, which
 * has no JSON functions.
 */
const BOT_FIRING_METADATA_PATTERN = '%"botId":%';

export interface SlackBotTriggerPolicyDeps {
  store: Pick<AutomationStore, "countEventFiringsSince">;
}

/** Which automations a message from another bot may start, and how often. */
export class SlackBotTriggerPolicy {
  constructor(private readonly deps: SlackBotTriggerPolicyDeps) {}

  /** Bot output is untrusted input, so only an explicit opt-in admits it. */
  accepts(config: TriggerConfig | null): boolean {
    return config?.slack?.includeBotMessages === true;
  }

  /** Whether bot messages already started SLACK_BOT_TRIGGER_LIMIT runs in the window. */
  async limitReached(automationId: string, now: number): Promise<boolean> {
    const botFirings = await this.deps.store.countEventFiringsSince(
      automationId,
      now - SLACK_BOT_TRIGGER_WINDOW_MS,
      BOT_FIRING_METADATA_PATTERN,
      SLACK_BOT_TRIGGER_LIMIT
    );
    return botFirings >= SLACK_BOT_TRIGGER_LIMIT;
  }
}
