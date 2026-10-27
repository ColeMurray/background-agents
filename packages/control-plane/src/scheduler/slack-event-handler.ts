import {
  matchesConditions,
  conditionRegistry,
  type SlackAutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import { parseAutomationTriggerFields } from "../db/automation-store";
import type { SlackChannelStore } from "../db/slack-channel-store";
import type { SessionContinuityService } from "./session-continuity-service";
import type { Logger } from "../logger";
import type { SchedulerEventResult } from "./contracts";
import type { AutomationInvocationService } from "./invocation-service";
import type { AutomationSlackService } from "./slack-service";
import type { SlackRunMetadata } from "./slack-completion";
import type { SlackContinuationPolicyFactory } from "./slack-continuation-policy";
import { composeAutomationPrompt } from "./event-prompt";
import { recordEventLaunch, recordContinuation, logEventResult } from "./event-outcome";

export interface SlackEventHandlerDeps {
  channels: Pick<SlackChannelStore, "getSlackAutomationsForChannel">;
  slack: Pick<
    AutomationSlackService,
    "getSessionInstructions" | "contextWithThread" | "notifySkip"
  >;
  invocations: Pick<AutomationInvocationService, "start">;
  continuity: Pick<SessionContinuityService, "continueSession">;
  policies: Pick<SlackContinuationPolicyFactory, "create">;
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

      let config: TriggerConfig;
      try {
        config = parseAutomationTriggerFields(automation).triggerConfig ?? { conditions: [] };
      } catch {
        deps.log.error("Skipped automation with invalid stored trigger fields", {
          event: "scheduler.invalid_trigger_fields",
          automation_id: automation.id,
        });
        summary.skipped++;
        continue;
      }
      if (!matchesConditions(config.conditions, event, conditionRegistry)) continue;

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
        triggerMetadata: serializeSlackTriggerMetadata(event),
        instructionsOverride: composeAutomationPrompt(event.contextBlock, instructions),
        // Admission owns when this is evaluated: skipped firings do not read the thread.
        instructionsOverrideFactory: async () =>
          composeAutomationPrompt(await contextBlock(), instructions),
      });
      if (result.outcome === "skipped") concurrencySkipped = true;
      recordEventLaunch(summary, result, automation, event, deps.log);
    }
    if (concurrencySkipped) await deps.slack.notifySkip(event);
    logEventResult(deps.log, event, summary, candidates.length);
    return summary;
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
  };
  return JSON.stringify(metadata);
}
