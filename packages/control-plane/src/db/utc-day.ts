/** Milliseconds in one UTC day. */
export const MS_PER_DAY = 86_400_000;

/**
 * Renders a UTC day index — a millisecond epoch integer-divided by
 * {@link MS_PER_DAY} — as `YYYY-MM-DD`.
 *
 * Day bucketing stays in SQL as `<column> / 86400000`, which is integer
 * division on SQLite and Postgres alike; calendar formatting stays here.
 */
export function utcDateFromDayIndex(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}
