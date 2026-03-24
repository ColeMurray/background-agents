/**
 * Condition system for trigger-based automations.
 *
 * Each condition type's shape is defined once in ConditionConfigMap.
 * TypeScript derives the discriminated union and typed handler interfaces from it.
 */

import type { AutomationEvent, AutomationEventSource } from "./types";

// ─── 1. ConditionConfigMap: single source of truth ───────────────────────────

export interface ConditionConfigMap {
  branch: { operator: "glob_match" | "exact"; value: string[] };
  label: { operator: "any_of" | "none_of"; value: string[] };
  path_glob: { operator: "any_match"; value: string[] };
  actor: { operator: "include" | "exclude"; value: string[] };
  check_conclusion: { operator: "eq"; value: string };
  linear_status: { operator: "any_of"; value: string[] };
  sentry_project: { operator: "any_of"; value: string[] };
  sentry_level: { operator: "any_of"; value: string[] };
  jsonpath: { operator: "all_match"; value: JsonPathFilter[] };
}

export interface JsonPathFilter {
  path: string;
  comparison: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists";
  value?: string | number | boolean;
}

// ─── 2. Derived discriminated union ──────────────────────────────────────────

export type TriggerCondition = {
  [K in keyof ConditionConfigMap]: { type: K } & ConditionConfigMap[K];
}[keyof ConditionConfigMap];

// ─── 3. Typed handler interface ──────────────────────────────────────────────

export type ConditionType = keyof ConditionConfigMap;

type ConditionOf<K extends ConditionType> = Extract<TriggerCondition, { type: K }>;

export interface ConditionHandler<K extends ConditionType> {
  /** Validate at automation creation time. Returns null if valid, error string otherwise. */
  validate(condition: ConditionOf<K>): string | null;

  /** Evaluate at event matching time. Returns true if the condition passes. */
  evaluate(condition: ConditionOf<K>, event: AutomationEvent): boolean;

  /** Which event sources this condition can be used with. */
  appliesTo: AutomationEventSource[];
}

// ─── 4. Typed registry ───────────────────────────────────────────────────────

export type ConditionRegistry = {
  [K in ConditionType]: ConditionHandler<K>;
};

// ─── 5. Dispatch ─────────────────────────────────────────────────────────────

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

// ─── 6. Validation (called at automation creation time) ──────────────────────

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

// ─── 7. TriggerConfig (stored as JSON in D1) ────────────────────────────────

export interface TriggerConfig {
  conditions: TriggerCondition[];
}
