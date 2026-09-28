const reviewDateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * Formats a YYYY-MM-DD review date as a calendar date. The value is date-only,
 * so it is anchored to UTC and never shifts to the previous day in western
 * time zones.
 */
export function formatReviewDate(isoDate: string): string {
  return reviewDateFormatter.format(new Date(`${isoDate}T00:00:00.000Z`));
}
