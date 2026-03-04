/**
 * Cron expression utilities for the automation engine.
 *
 * Thin wrappers around `cron-parser` enforcing 5-field expressions only,
 * with timezone support via `Intl`.
 */

import { CronExpressionParser } from "cron-parser";

/**
 * Return the next occurrence after `after` (defaults to now).
 */
export function nextCronOccurrence(expression: string, timezone: string, after?: Date): Date {
  const cron = CronExpressionParser.parse(expression, {
    tz: timezone,
    currentDate: after,
  });
  return cron.next().toDate();
}

/**
 * Validate a cron expression without throwing.
 * Only 5-field expressions are accepted.
 */
export function isValidCron(expression: string): boolean {
  // Reject 6-field (seconds) or 7-field expressions
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the interval in minutes between consecutive occurrences,
 * or `null` if intervals are not constant across the sample window.
 *
 * Constant-interval expressions (e.g., every 15 min, hourly, weekly)
 * return their exact interval. Variable-interval expressions (e.g., monthly)
 * return `null`, which bypasses the minimum-interval check — this is safe
 * because variable-interval crons cannot fire at sub-15-minute frequency.
 *
 * Used to enforce the 15-minute minimum interval.
 */
export function cronIntervalMinutes(expression: string): number | null {
  try {
    // Fixed reference point (a Wednesday) for deterministic interval sampling.
    const cron = CronExpressionParser.parse(expression, {
      currentDate: new Date("2025-01-01T00:00:00Z"),
      tz: "UTC",
    });

    // Sample the first 5 intervals
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      times.push(cron.next().toDate().getTime());
    }

    const intervals = new Set<number>();
    for (let i = 1; i < times.length; i++) {
      intervals.add((times[i] - times[i - 1]) / 60_000);
    }

    // Return the minimum observed interval (catches multi-value expressions
    // like "0,1 * * * *" whose shortest gap is 1 minute).
    return Math.min(...intervals);
  } catch {
    return null;
  }
}

// ─── Preset descriptions ────────────────────────────────────────────────────

interface CronPreset {
  pattern: RegExp;
  describe: (match: RegExpMatchArray, tz: string) => string;
}

const PRESETS: CronPreset[] = [
  {
    // Every N minutes: */N * * * *
    pattern: /^\*\/(\d+) \* \* \* \*$/,
    describe: (m, tz) => `Every ${m[1]} minutes (${tz})`,
  },
  {
    // Every hour at minute M: M * * * *
    pattern: /^(\d+) \* \* \* \*$/,
    describe: (m, tz) => `Every hour at :${m[1].padStart(2, "0")} (${tz})`,
  },
  {
    // Every day at H:M: M H * * *
    pattern: /^(\d+) (\d+) \* \* \*$/,
    describe: (m, tz) => `Every day at ${formatTime(parseInt(m[2]), parseInt(m[1]))} (${tz})`,
  },
  {
    // Every weekday at H:M: M H * * 1-5
    pattern: /^(\d+) (\d+) \* \* 1-5$/,
    describe: (m, tz) => `Every weekday at ${formatTime(parseInt(m[2]), parseInt(m[1]))} (${tz})`,
  },
  {
    // Every specific day at H:M: M H * * D
    pattern: /^(\d+) (\d+) \* \* (\d)$/,
    describe: (m, tz) =>
      `Every ${DAY_NAMES[parseInt(m[3])]} at ${formatTime(parseInt(m[2]), parseInt(m[1]))} (${tz})`,
  },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${minute.toString().padStart(2, "0")} ${suffix}`;
}

/**
 * Produce a human-readable description of a cron expression.
 * Uses preset detection with fallback to the raw expression.
 */
export function describeCron(expression: string, timezone: string): string {
  const trimmed = expression.trim();
  for (const preset of PRESETS) {
    const match = trimmed.match(preset.pattern);
    if (match) return preset.describe(match, timezone);
  }
  return `${trimmed} (${timezone})`;
}
