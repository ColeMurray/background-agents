/**
 * Condition system for trigger-based automations.
 *
 * TypeScript derives typed handler interfaces from the trigger configuration
 * shapes, while this module owns runtime validation and evaluation.
 */

import type {
  AutomationEvent,
  AutomationEventSource,
  ConditionType,
  TriggerCondition,
} from "./types";
import { getGitHubConclusionOptions, isGitHubConditionSupported } from "./github/webhook-types";

type ConditionOf<K extends ConditionType> = Extract<TriggerCondition, { type: K }>;

export interface ConditionHandler<K extends ConditionType> {
  /** Validate at automation creation time. Returns null if valid, error string otherwise. */
  validate(condition: ConditionOf<K>, eventType?: string): string | null;

  /** Evaluate at event matching time. Returns true if the condition passes. */
  evaluate(condition: ConditionOf<K>, event: AutomationEvent): boolean;

  /** Which event sources this condition can be used with. */
  appliesTo: readonly AutomationEventSource[];
}

// ─── Typed Registry ──────────────────────────────────────────────────────────

export type ConditionRegistry = {
  [K in ConditionType]: ConditionHandler<K>;
};

export function getConditionSemanticKey(type: ConditionType): ConditionType {
  return type === "check_conclusion" ? "conclusion" : type;
}

export function dedupeConditionsBySemanticKey(
  conditions: readonly TriggerCondition[]
): TriggerCondition[] {
  const seen = new Set<ConditionType>();
  return conditions.filter((condition) => {
    const key = getConditionSemanticKey(condition.type);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isGitHubConditionCompatible(
  eventType: string,
  condition: TriggerCondition
): boolean {
  if (!isGitHubConditionSupported(eventType, condition.type)) return false;
  if (condition.type !== "conclusion" && condition.type !== "check_conclusion") return true;
  return getGitHubConclusionOptions(eventType).includes(condition.value);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export function matchesConditions(
  conditions: TriggerCondition[],
  event: AutomationEvent,
  registry: ConditionRegistry
): boolean {
  return conditions.every((condition) => {
    const handler = registry[condition.type] as ConditionHandler<typeof condition.type>;
    return handler.evaluate(condition, event);
  });
}

// ─── Validation (called at automation creation time) ────────────────────────

export function validateConditions(
  conditions: TriggerCondition[],
  triggerSource: AutomationEventSource,
  registry: ConditionRegistry,
  eventType?: string
): string[] {
  const errors: string[] = [];
  for (const condition of conditions) {
    const handler = registry[condition.type] as ConditionHandler<typeof condition.type>;
    if (!handler.appliesTo.includes(triggerSource)) {
      errors.push(`Condition "${condition.type}" does not apply to ${triggerSource} triggers`);
      continue;
    }
    if (triggerSource === "github") {
      if (!eventType) {
        errors.push(`Condition "${condition.type}" requires a GitHub event type`);
        continue;
      }
      if (!isGitHubConditionSupported(eventType, condition.type)) {
        errors.push(`Condition "${condition.type}" does not apply to GitHub event ${eventType}`);
        continue;
      }
    }
    const err = handler.validate(condition, eventType);
    if (err) errors.push(err);
  }
  return errors;
}
