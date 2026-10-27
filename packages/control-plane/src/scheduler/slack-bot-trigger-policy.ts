import { hasSlackActorIncludeList, type TriggerConfig } from "@open-inspect/shared/triggers";
import type { AutomationStore } from "../db/automation-store";

/**
 * Most runs that bot messages may start for one automation within
 * SLACK_BOT_TRIGGER_WINDOW_MS. A run's output can prompt another bot to post in
 * the watched channel, so an automation that accepts bot messages could
 * otherwise trigger itself indefinitely.
 *
 * The count is read before the firing is inserted, so simultaneous bot messages
 * can overshoot it, including several bots answering one run at once. A loop in
 * which one bot answers each run cannot: each firing follows the previous run,
 * which is already counted.
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
  store: Pick<AutomationStore, "countEventFiringsSince" | "hasSkippedInvocationSince">;
}

/**
 * Where a bot message stands against the hourly limit. Over it, only the first
 * refused message in the window is recorded as a skip, so a busy bot cannot
 * flood the run history; later ones are refused without a row.
 */
export type SlackBotLimitState = "under_limit" | "over_limit" | "over_limit_recorded";

/** Which automations a message from another bot may start, and how often. */
export class SlackBotTriggerPolicy {
  constructor(private readonly deps: SlackBotTriggerPolicyDeps) {}

  /**
   * Bot output is untrusted input, so only an explicit opt-in admits it, and
   * only with a Slack User include list naming the bots. Saving enforces the
   * list too; checking it here keeps an unlisted bot out whatever was stored.
   */
  accepts(config: TriggerConfig | null): boolean {
    return (
      config?.slack?.includeBotMessages === true && hasSlackActorIncludeList(config.conditions)
    );
  }

  /** Where a bot message stands against SLACK_BOT_TRIGGER_LIMIT runs in the window. */
  async limitState(automationId: string, now: number): Promise<SlackBotLimitState> {
    const since = now - SLACK_BOT_TRIGGER_WINDOW_MS;
    const botFirings = await this.deps.store.countEventFiringsSince(
      automationId,
      since,
      BOT_FIRING_METADATA_PATTERN,
      SLACK_BOT_TRIGGER_LIMIT
    );
    if (botFirings < SLACK_BOT_TRIGGER_LIMIT) return "under_limit";
    const recorded = await this.deps.store.hasSkippedInvocationSince(
      automationId,
      SLACK_BOT_TRIGGER_LIMIT_SKIP_REASON,
      since
    );
    return recorded ? "over_limit_recorded" : "over_limit";
  }
}
