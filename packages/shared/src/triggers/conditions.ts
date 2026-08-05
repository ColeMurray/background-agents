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

type ConditionOf<K extends ConditionType> = Extract<TriggerCondition, { type: K }>;

export interface ConditionHandler<K extends ConditionType> {
  /** Validate at automation creation time. Returns null if valid, error string otherwise. */
  validate(condition: ConditionOf<K>): string | null;

  /** Evaluate at event matching time. Returns true if the condition passes. */
  evaluate(condition: ConditionOf<K>, event: AutomationEvent): boolean;

  /** Which event sources this condition can be used with. */
  appliesTo: AutomationEventSource[];
}

// ─── Typed Registry ──────────────────────────────────────────────────────────

export type ConditionRegistry = {
  [K in ConditionType]: ConditionHandler<K>;
};

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
  registry: ConditionRegistry
): string[] {
  const errors: string[] = [];
  for (const condition of conditions) {
    const handler = registry[condition.type] as ConditionHandler<typeof condition.type>;
    if (!handler.appliesTo.includes(triggerSource)) {
      errors.push(`Condition "${condition.type}" does not apply to ${triggerSource} triggers`);
      continue;
    }
    const err = handler.validate(condition);
    if (err) errors.push(err);
  }
  return errors;
}
