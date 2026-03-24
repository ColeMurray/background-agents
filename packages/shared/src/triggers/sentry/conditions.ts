/**
 * Sentry-specific condition handlers: sentry_project, sentry_level.
 */

import type { ConditionRegistry } from "../conditions";

export const conditions = {
  sentry_project: {
    appliesTo: ["sentry"] as const,
    validate(c) {
      return c.value.length === 0 ? "At least one project required" : null;
    },
    evaluate(c, event) {
      if (event.source !== "sentry") return true;
      return c.value.includes(event.sentryProject);
    },
  },
  sentry_level: {
    appliesTo: ["sentry"] as const,
    validate(c) {
      return c.value.length === 0 ? "At least one level required" : null;
    },
    evaluate(c, event) {
      if (event.source !== "sentry") return true;
      return c.value.includes(event.sentryLevel);
    },
  },
} as const satisfies Partial<ConditionRegistry>;
