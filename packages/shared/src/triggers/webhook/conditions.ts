/**
 * Webhook-specific condition handlers: jsonpath.
 */

import type { ConditionRegistry } from "../conditions";
import type { JsonPathFilter } from "../conditions";
import { evaluateJsonPathFilter } from "./normalizer";

export const conditions = {
  jsonpath: {
    appliesTo: ["webhook"] as const,
    validate(c) {
      return c.value.length === 0 ? "At least one filter required" : null;
    },
    evaluate(c, event) {
      if (event.source !== "webhook") return true;
      return c.value.every((filter: JsonPathFilter) => evaluateJsonPathFilter(filter, event.body));
    },
  },
} as const satisfies Partial<ConditionRegistry>;
