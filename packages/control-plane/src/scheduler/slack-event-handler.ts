import {
  matchesConditions,
  conditionRegistry,
  type SlackAutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import { parseAutomationTriggerFields, type AutomationRow } from "../db/automation-store";
import type { SlackChannelStore } from "../db/slack-channel-store";
import type { SessionContinuityService } from "./session-continuity-service";
import type { Logger } from "../logger";
import type { SchedulerEventResult } from "./contracts";
import type { AutomationInvocationService } from "./invocation-service";
import type { AutomationSlackService } from "./slack-service";
import type { SlackRunMetadata } from "./slack-completion";
import type { SlackContinuationPolicyFactory } from "./slack-continuation-policy";
import { composeAutomationPrompt } from "./event-prompt";
import {
  SLACK_BOT_TRIGGER_LIMIT,
  SLACK_BOT_TRIGGER_LIMIT_SKIP_REASON,
  type SlackBotTriggerPolicy,
} from "./slack-bot-trigger-policy";
import { recordEventLaunch, recordContinuation, logEventResult } from "./event-outcome";

export interface SlackEventHandlerDeps {
  channels: Pick<SlackChannelStore, "getSlackAutomationsForChannel">;
  slack: Pick<
    AutomationSlackService,
    "getSessionInstructions" | "contextWithThread" | "notifySkip"
  >;
  invocations: Pick<AutomationInvocationService, "start" | "skipEvent">;
  continuity: Pick<SessionContinuityService, "continueSession">;
  policies: Pick<SlackContinuationPolicyFactory, "create">;
  bots: Pick<SlackBotTriggerPolicy, "accepts" | "limitState">;
  clock: Pick<DateConstructor, "now">;
  log: Logger;
}

/** Continue thread replies before evaluating conditions for a new firing. */
export class SlackEventHandler {
  constructor(private readonly deps: SlackEventHandlerDeps) {}

  async handle(event: SlackAutomationEvent): Promise<SchedulerEventResult> {
    const deps = this.deps;
    const candidates = await deps.channels.getSlackAutomationsForChannel(event.channelId);
    // Share lazy reads across candidates, but never across incoming events.
    let contextPromise: Promise<string> | undefined;
    const contextBlock = () => (contextPromise ??= deps.slack.contextWithThread(event));
    const policy = deps.policies.create(event);
    let sessionInstructions: string | undefined;
    let settingsLoaded = false;
    let concurrencySkipped = false;
    const summary: SchedulerEventResult = {
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [],
    };

    for (const automation of candidates) {
      const now = deps.clock.now();
      const config = readTriggerConfig(automation);
      // Checked ahead of continuity, so a bot's reply cannot reach the session of
      // an automation that has not opted in to bot messages either.
      if (event.botId !== undefined && !deps.bots.accepts(config)) continue;

      // A reply need not repeat the keyword that started the original session.
      // A missing or refusing session falls through to new-trigger evaluation.
      const outcome = await deps.continuity.continueSession(
        automation,
        event.concurrencyKey,
        now,
        policy
      );
      if (outcome.kind === "steered" || outcome.kind === "skipped") {
        recordContinuation(summary, outcome);
        continue;
      }

      if (!config) {
        deps.log.error("Skipped automation with invalid stored trigger fields", {
          event: "scheduler.invalid_trigger_fields",
          automation_id: automation.id,
        });
        summary.skipped++;
        continue;
      }
      if (!matchesConditions(config.conditions, event, conditionRegistry)) continue;

      const triggerMetadata = serializeSlackTriggerMetadata(event);
      const botLimit =
        event.botId === undefined ? "under_limit" : await deps.bots.limitState(automation.id, now);
      if (botLimit === "over_limit_recorded") {
        summary.skipped++;
        continue;
      }
      if (botLimit === "over_limit") {
        deps.log.warn("Skipped a bot-triggered Slack firing over the hourly limit", {
          event: "scheduler.slack_bot_trigger_limited",
          automation_id: automation.id,
          trigger_key: event.triggerKey,
          limit: SLACK_BOT_TRIGGER_LIMIT,
        });
        const result = await deps.invocations.skipEvent(
          {
            automation,
            triggerKey: event.triggerKey,
            concurrencyKey: event.concurrencyKey,
            triggerMetadata,
          },
          SLACK_BOT_TRIGGER_LIMIT_SKIP_REASON
        );
        recordEventLaunch(summary, result, automation, event, deps.log);
        continue;
      }

      if (!settingsLoaded) {
        sessionInstructions = await deps.slack.getSessionInstructions();
        settingsLoaded = true;
      }
      const instructions = appendSlackSessionInstructions(
        automation.instructions,
        sessionInstructions
      );
      const result = await deps.invocations.start({
        automation,
        source: "event",
        triggerKey: event.triggerKey,
        concurrencyKey: event.concurrencyKey,
        triggerMetadata,
        instructionsOverride: composeAutomationPrompt(event.contextBlock, instructions),
        // Admission owns when this is evaluated: skipped firings do not read the thread.
        instructionsOverrideFactory: async () =>
          composeAutomationPrompt(await contextBlock(), instructions),
      });
      if (result.outcome === "skipped") concurrencySkipped = true;
      recordEventLaunch(summary, result, automation, event, deps.log);
    }
    // The "already active" notice is an ephemeral to the author, which a bot cannot receive.
    if (concurrencySkipped && event.botId === undefined) await deps.slack.notifySkip(event);
    logEventResult(deps.log, event, summary, candidates.length);
    return summary;
  }
}

/** The automation's trigger config, or null when its stored fields do not parse. */
function readTriggerConfig(automation: AutomationRow): TriggerConfig | null {
  try {
    return parseAutomationTriggerFields(automation).triggerConfig ?? { conditions: [] };
  } catch {
    return null;
  }
}

function appendSlackSessionInstructions(prompt: string, instructions: string | undefined): string {
  return instructions ? `${prompt}\n\n## Additional Instructions\n\n${instructions}` : prompt;
}

/**
 * Serialize a slack event's message coordinates for the invocation's
 * trigger_metadata — carried by both real firings and concurrency skips.
 */
function serializeSlackTriggerMetadata(event: SlackAutomationEvent): string {
  const metadata: SlackRunMetadata = {
    channel: event.channelId,
    messageTs: event.ts,
    botId: event.botId,
  };
  return JSON.stringify(metadata);
}
