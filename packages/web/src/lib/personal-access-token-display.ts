/**
 * How token lists describe a personal access token's use and lifetime, shared by the user's own
 * list and the administrators' list of every member's tokens.
 */

import { formatFutureRelativeTime, formatRelativeTime } from "@/lib/time";

export function formatLastUsed(lastUsedAt: number | null): string {
  if (lastUsedAt === null) return "Never used";
  const elapsed = formatRelativeTime(lastUsedAt);
  return elapsed === "now" ? "Last used just now" : `Last used ${elapsed} ago`;
}

export function formatTokenDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** `expiresAt` is the effective expiry, under the workspace policy's lifetime cap. */
export function formatTokenExpiry(expiresAt: number, now: number): string {
  return expiresAt <= now
    ? `Expired ${formatTokenDate(expiresAt)}`
    : `Expires ${formatFutureRelativeTime(expiresAt)}`;
}
