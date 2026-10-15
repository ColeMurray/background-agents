import {
  conditionRegistry,
  matchesConditions,
  type AutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import { parseAutomationTriggerFields, type AutomationRow } from "../db/automation-store";
import type { Logger } from "../logger";
import type { StartInvocationParams } from "./scheduler";
import type { StartInvocationResult } from "./invocation-outcome";
import type { ContinuationOutcome } from "./session-continuity";

export type EventInvocationOptions = Pick<
  StartInvocationParams,
  | "invocationId"
  | "webhookFollowUpClaimId"
  | "triggerMetadata"
  | "instructionsOverride"
  | "instructionsOverrideFactory"
>;

export type FireEvent = (options: EventInvocationOptions) => Promise<StartInvocationResult>;
export type EventDispatchOutcome =
  StartInvocationResult | Extract<ContinuationOutcome, { kind: "steered" | "skipped" }> | null;

/** A policy lives for one event, so shared context and skip notices cannot leak to another. */
export interface EventSourcePolicy {
  candidates(): Promise<AutomationRow[]>;
  dispatch(automation: AutomationRow, now: number, fire: FireEvent): Promise<EventDispatchOutcome>;
  finish?(): Promise<void>;
}

/** Invalid persisted fields count as a skip; ordinary condition mismatches do not. */
export function evaluateEventConditions(
  automation: AutomationRow,
  event: AutomationEvent,
  log: Logger
): "matched" | "unmatched" | "invalid" {
  let config: TriggerConfig;
  try {
    config = parseAutomationTriggerFields(automation).triggerConfig ?? { conditions: [] };
  } catch {
    log.error("Skipped automation with invalid stored trigger fields", {
      event: "scheduler.invalid_trigger_fields",
      automation_id: automation.id,
    });
    return "invalid";
  }
  return matchesConditions(config.conditions, event, conditionRegistry) ? "matched" : "unmatched";
}
