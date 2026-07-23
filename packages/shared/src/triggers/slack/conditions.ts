/**
 * Slack condition handlers (text_match / slack_channel / slack_actor).
 *
 * Co-located with the rest of the slack trigger source (source definition,
 * normalizer) and assembled into the central registry by `../registry`. Kept
 * here — rather than inline in the registry — so the source owns its conditions,
 * matching the sentry/webhook modules.
 */

import type { ConditionRegistry, TextMatchValue } from "../conditions";
import type { AutomationEvent } from "../types";
import { SLACK_TEXT_MAX_LENGTH } from "./normalizer";

/** Max length of a user-supplied `text_match` regex pattern (characters). */
export const REGEX_PATTERN_MAX_LENGTH = 200;

/** Regex flags accepted for the `text_match` `regex` operator. */
export const ALLOWED_REGEX_FLAGS = new Set(["i", "m"]);

/** True when every flag character is on the allowlist (empty/undefined is allowed). */
function flagsAllowed(flags: string | undefined): boolean {
  if (!flags) return true;
  for (const flag of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) return false;
  }
  return true;
}

/**
 * True when `value` is an array of one or more non-empty strings. The condition
 * value arrives as untrusted JSON typed only by assertion, so the handlers below
 * verify the runtime shape before it is persisted — a bare string would satisfy
 * the TypeScript type's `.length` check and then be iterated character-by-character
 * when the watched-channel index is built.
 */
function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v !== "")
  );
}

/**
 * Slack condition handlers. `slack_actor` is a distinct slack-only handler — the
 * github/linear `actor` handler passes through for slack, so it cannot be reused.
 */
export const slackConditions = {
  text_match: {
    appliesTo: ["slack"] as const,
    validate(c: { operator: "contains" | "exact" | "regex"; value: TextMatchValue }) {
      const value = c.value as unknown;
      if (typeof value !== "object" || value === null) {
        return "text_match value must be an object with a pattern";
      }
      const { pattern, flags } = value as { pattern?: unknown; flags?: unknown };
      if (typeof pattern !== "string" || pattern === "") return "Text match pattern is required";
      if (pattern.length > REGEX_PATTERN_MAX_LENGTH) {
        return `Pattern exceeds the ${REGEX_PATTERN_MAX_LENGTH}-character limit`;
      }
      if (flags !== undefined && typeof flags !== "string") {
        return "text_match flags must be a string";
      }
      if (!flagsAllowed(flags)) return "Unsupported regex flag";
      if (c.operator === "regex") {
        try {
          new RegExp(pattern, flags ?? "");
        } catch {
          return "Invalid regex pattern";
        }
      }
      return null;
    },
    evaluate(
      c: { operator: "contains" | "exact" | "regex"; value: TextMatchValue },
      event: AutomationEvent
    ) {
      if (event.source !== "slack") return true;
      const { text } = event;
      // Defensive input bound — the normalizer already caps text at this length.
      if (text.length > SLACK_TEXT_MAX_LENGTH) return false;
      const { pattern, flags } = c.value;
      const caseInsensitive = flags?.includes("i") ?? false;
      if (c.operator === "contains") {
        return caseInsensitive
          ? text.toLowerCase().includes(pattern.toLowerCase())
          : text.includes(pattern);
      }
      if (c.operator === "exact") {
        return caseInsensitive ? text.toLowerCase() === pattern.toLowerCase() : text === pattern;
      }
      // regex
      if (pattern.length > REGEX_PATTERN_MAX_LENGTH) return false;
      if (!flagsAllowed(flags)) return false;
      try {
        return new RegExp(pattern, flags ?? "").test(text);
      } catch {
        return false;
      }
    },
  },
  slack_channel: {
    appliesTo: ["slack"] as const,
    validate(c: { value: string[] }) {
      return isNonEmptyStringArray(c.value)
        ? null
        : "slack_channel requires at least one channel ID";
    },
    evaluate(c: { value: string[] }, event: AutomationEvent) {
      if (event.source !== "slack") return true;
      return c.value.includes(event.channelId);
    },
  },
  slack_actor: {
    appliesTo: ["slack"] as const,
    validate(c: { value: string[] }) {
      return isNonEmptyStringArray(c.value) ? null : "slack_actor requires at least one user ID";
    },
    evaluate(c: { operator: "include" | "exclude"; value: string[] }, event: AutomationEvent) {
      if (event.source !== "slack") return true;
      const inList = c.value.includes(event.actorUserId);
      return c.operator === "include" ? inList : !inList;
    },
  },
} satisfies Partial<ConditionRegistry>;
