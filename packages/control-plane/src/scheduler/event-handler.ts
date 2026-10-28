import {
  matchesConditions,
  conditionRegistry,
  type AutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import {
  parseAutomationTriggerFields,
  type AutomationRow,
  type AutomationStore,
} from "../db/automation-store";
import type { admitGitHubEvent } from "../automation/github-event-admission";
import type { Logger } from "../logger";
import type { SchedulerEventResult } from "./contracts";
import type { AutomationInvocationService } from "./invocation-service";
import { composeAutomationPrompt } from "./event-prompt";
import { recordEventLaunch, logEventResult } from "./event-outcome";
import type { SlackEventHandler } from "./slack-event-handler";
import type { WebhookEventHandler } from "./webhook-event-handler";

export interface AutomationEventHandlerDeps {
  store: Pick<AutomationStore, "getById" | "getAutomationsForEvent">;
  invocations: Pick<AutomationInvocationService, "start">;
  admitGitHubEvent(
    event: Parameters<typeof admitGitHubEvent>[1],
    fire: Parameters<typeof admitGitHubEvent>[2]
  ): Promise<SchedulerEventResult>;
  slack: Pick<SlackEventHandler, "handle">;
  webhook: Pick<WebhookEventHandler, "handle">;
  log: Logger;
}

/** Route incoming events to their source-specific admission and continuity rules. */
export class AutomationEventHandler {
  constructor(private readonly deps: AutomationEventHandlerDeps) {}

  async handle(event: AutomationEvent): Promise<SchedulerEventResult> {
    const { store, invocations, log } = this.deps;
    switch (event.source) {
      case "github":
        return this.deps.admitGitHubEvent(event, (automation, repositories) =>
          invocations.start({
            automation,
            repositories,
            source: "event",
            // Absent from older github-bots, and when GitHub's sender is missing
            // or neither a User nor a Bot.
            actorKind: event.actorKind ?? "unknown",
            triggerKey: event.triggerKey,
            concurrencyKey: event.concurrencyKey,
            eventRepositoryId: event.repositoryId,
            instructionsOverride: composeAutomationPrompt(
              event.contextBlock,
              automation.instructions
            ),
          })
        );
      case "slack":
        return this.deps.slack.handle(event);
      case "webhook":
        return this.deps.webhook.handle(event);
    }

    let candidates: AutomationRow[];
    if (event.source === "sentry") {
      const automation = await store.getById(event.automationId);
      candidates =
        automation &&
        automation.enabled === 1 &&
        !automation.deleted_at &&
        automation.event_type === event.eventType
          ? [automation]
          : [];
    } else {
      candidates = await store.getAutomationsForEvent(
        event.repoOwner,
        event.repoName,
        "linear_event",
        event.eventType
      );
    }
    const summary: SchedulerEventResult = {
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [],
    };
    for (const automation of candidates) {
      let config: TriggerConfig;
      try {
        config = parseAutomationTriggerFields(automation).triggerConfig ?? { conditions: [] };
      } catch {
        log.error("Skipped automation with invalid stored trigger fields", {
          event: "scheduler.invalid_trigger_fields",
          automation_id: automation.id,
        });
        summary.skipped++;
        continue;
      }
      if (!matchesConditions(config.conditions, event, conditionRegistry)) continue;
      const result = await invocations.start({
        automation,
        source: "event",
        actorKind: "unknown",
        triggerKey: event.triggerKey,
        concurrencyKey: event.concurrencyKey,
        triggerMetadata: null,
        instructionsOverride: composeAutomationPrompt(event.contextBlock, automation.instructions),
      });
      recordEventLaunch(summary, result, automation, event, log);
    }
    logEventResult(log, event, summary, candidates.length);
    return summary;
  }
}
