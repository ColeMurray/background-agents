import type { AutomationEvent } from "@open-inspect/shared/triggers";
import { allRunsUnauthorized, type AutomationRow } from "../db/automation-store";
import type { Logger } from "../logger";
import type { SchedulerEventResult } from "./contracts";
import { firingInvocationId, type StartInvocationResult } from "./invocation-outcome";
import type { ContinuationOutcome } from "./session-continuity";

/** Preserve event counters: a failed launch counts as neither triggered nor skipped. */
export function recordEventLaunch(
  summary: SchedulerEventResult,
  result: StartInvocationResult,
  automation: AutomationRow,
  event: AutomationEvent,
  log: Logger
): void {
  const invocationId = firingInvocationId(result);
  if (invocationId) summary.invocationIds.push(invocationId);
  switch (result.outcome) {
    case "started":
      if (result.launched > 0) summary.triggered++;
      else if (allRunsUnauthorized(result.runs)) summary.skipped++;
      break;
    case "skipped":
    case "deduplicated":
    case "blocked":
      summary.skipped++;
      break;
    case "unauthorized":
      log.warn("Skipped event automation after execution authorization denial", {
        event: "scheduler.authorization_denied",
        automation_id: automation.id,
        source: event.source,
        reason_code: result.reason ?? "execution_authorization_denied",
      });
      summary.skipped++;
      break;
  }
}

export function recordContinuation(
  summary: SchedulerEventResult,
  outcome: Extract<ContinuationOutcome, { kind: "steered" | "skipped" }>
): void {
  if (outcome.kind === "steered") summary.steered++;
  else summary.skipped++;
  if (outcome.invocationId) summary.invocationIds.push(outcome.invocationId);
}

export function logEventResult(
  log: Logger,
  event: AutomationEvent,
  result: SchedulerEventResult,
  candidateCount: number
): void {
  log.info("Event processed", {
    event: "scheduler.event_processed",
    source: event.source,
    event_type: event.eventType,
    trigger_key: event.triggerKey,
    triggered: result.triggered,
    skipped: result.skipped,
    steered: result.steered,
    candidates: candidateCount,
  });
}
