/**
 * Time formatting utilities for displaying relative timestamps.
 */

const SESSION_EVENT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
};

/**
 * Format a session event timestamp, stored in seconds, as a compact local time.
 */
export function formatSessionEventTime(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleTimeString([], SESSION_EVENT_TIME_FORMAT);
}

/**
 * Format a timestamp as a relative time string (e.g., "2d", "3h", "5m").
 * Returns "just now" for very recent timestamps.
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "just now";
}

/**
 * Group sessions by activity status.
 * Sessions older than 7 days are considered "inactive".
 */
export function isInactiveSession(updatedAt: number, now: number): boolean {
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  return updatedAt < sevenDaysAgo;
}
