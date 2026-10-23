import type { AutomationEvent } from "@open-inspect/shared/triggers";
import { allRunsUnauthorized, type AutomationRow } from "../db/automation-store";
import { admitGitHubEvent } from "../automation/github-event-admission";
import type { StartInvocationParams, SchedulerEventResult } from "./scheduler";
import { composeAutomationPrompt } from "./event-prompt";
import { firingInvocationId, type StartInvocationResult } from "./invocation-outcome";
import { evaluateEventConditions, type EventSourcePolicy } from "./event-policy";
import { createSlackEventPolicy, type SlackEventPolicyDeps } from "./slack-event-policy";
import { createWebhookEventPolicy } from "./webhook-event-policy";
import type { SessionContinuityDeps } from "./session-continuity";

interface EventDispatchDeps {
  continuity: SessionContinuityDeps;
  slack: Omit<SlackEventPolicyDeps, "continuity">;
  fire(params: StartInvocationParams): Promise<StartInvocationResult>;
}

/** Route each event through its source's admission rules and the shared firing pipeline. */
export async function dispatchAutomationEvent(
  event: AutomationEvent,
  deps: EventDispatchDeps
): Promise<SchedulerEventResult> {
  const { continuity, fire } = deps;
  const { db, store, log } = continuity;
  // GitHub admission retries grant-version races as a unit; retain its existing boundary.
  if (event.source === "github") {
    return admitGitHubEvent(
      db,
      event,
      (automation, repositories) =>
        fire({
          automation,
          repositories,
          source: "event",
          triggerKey: event.triggerKey,
          concurrencyKey: event.concurrencyKey,
          eventRepositoryId: event.repositoryId,
          instructionsOverride: composeAutomationPrompt(
            event.contextBlock,
            automation.instructions
          ),
        }),
      log
    );
  }

  let policy: EventSourcePolicy;
  switch (event.source) {
    case "slack":
      policy = createSlackEventPolicy(event, { continuity, ...deps.slack });
      break;
    case "webhook":
      policy = await createWebhookEventPolicy(event, continuity);
      break;
    case "sentry":
      policy = genericPolicy(async () => {
        const automation = await store.getById(event.automationId);
        return automation &&
          automation.enabled === 1 &&
          !automation.deleted_at &&
          automation.event_type === event.eventType
          ? [automation]
          : [];
      });
      break;
    case "linear":
      policy = genericPolicy(() =>
        store.getAutomationsForEvent(
          event.repoOwner,
          event.repoName,
          "linear_event",
          event.eventType
        )
      );
      break;
  }

  function genericPolicy(candidates: () => Promise<AutomationRow[]>): EventSourcePolicy {
    return {
      candidates,
      async dispatch(automation, _now, start) {
        const conditions = evaluateEventConditions(automation, event, log);
        if (conditions !== "matched")
          return conditions === "invalid" ? { kind: "skipped", invocationId: null } : null;
        return start({
          instructionsOverride: composeAutomationPrompt(
            event.contextBlock,
            automation.instructions
          ),
        });
      },
    };
  }

  const candidates = await policy.candidates();
  let triggered = 0;
  let skipped = 0;
  let steered = 0;
  const invocationIds: string[] = [];
  for (const automation of candidates) {
    const result = await policy.dispatch(automation, Date.now(), (options) =>
      fire({
        automation,
        source: "event",
        triggerKey: event.triggerKey,
        concurrencyKey: event.concurrencyKey,
        triggerMetadata: null,
        ...options,
      })
    );
    if (!result) continue;
    if ("kind" in result) {
      if (result.kind === "steered") steered++;
      else skipped++;
      if (result.invocationId) invocationIds.push(result.invocationId);
      continue;
    }
    const invocationId = firingInvocationId(result);
    if (invocationId) invocationIds.push(invocationId);
    switch (result.outcome) {
      case "started":
        if (result.launched > 0) triggered++;
        else if (allRunsUnauthorized(result.runs)) skipped++;
        break;
      case "skipped":
      case "deduplicated":
      case "blocked":
        skipped++;
        break;
      case "unauthorized":
        log.warn("Skipped event automation after execution authorization denial", {
          event: "scheduler.authorization_denied",
          automation_id: automation.id,
          source: event.source,
          reason_code: result.reason ?? "execution_authorization_denied",
        });
        skipped++;
        break;
    }
  }
  await policy.finish?.();
  log.info("Event processed", {
    event: "scheduler.event_processed",
    source: event.source,
    event_type: event.eventType,
    trigger_key: event.triggerKey,
    triggered,
    skipped,
    steered,
    candidates: candidates.length,
  });
  return { triggered, skipped, steered, invocationIds };
}
