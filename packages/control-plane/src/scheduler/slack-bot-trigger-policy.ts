import type { TriggerConfig } from "@open-inspect/shared/triggers";
import type { AutomationStore } from "../db/automation-store";
import { parseSlackTriggerMetadata } from "./slack-completion";

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

export interface SlackBotTriggerPolicyDeps {
  store: Pick<AutomationStore, "listEventTriggerMetadataSince">;
}

/** Which automations a message from another bot may start, and how often. */
export class SlackBotTriggerPolicy {
  constructor(private readonly deps: SlackBotTriggerPolicyDeps) {}

  /** Bot output is untrusted input, so only an explicit opt-in admits it. */
  accepts(config: TriggerConfig | null): boolean {
    return config?.slack?.includeBotMessages === true;
  }

  /**
   * Whether bot messages already started SLACK_BOT_TRIGGER_LIMIT runs in the
   * window. Counted here rather than in SQL, which has no portable way to read
   * the metadata's `botId`.
   */
  async limitReached(automationId: string, now: number): Promise<boolean> {
    const metadata = await this.deps.store.listEventTriggerMetadataSince(
      automationId,
      now - SLACK_BOT_TRIGGER_WINDOW_MS
    );
    const botFirings = metadata.filter((raw) => parseSlackTriggerMetadata(raw)?.botId).length;
    return botFirings >= SLACK_BOT_TRIGGER_LIMIT;
  }
}
