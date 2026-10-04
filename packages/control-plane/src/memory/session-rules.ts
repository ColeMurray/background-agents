import type { MemorySession } from "./types";

/**
 * How much of the pinned personal store a session may read live. Opted-out sessions see none;
 * children see only personal records pinned in the selection they inherited, so a later
 * preference or new personal record never widens a delegated session's context.
 */
export function personalReadAccess(session: MemorySession): "none" | "pinned" | "all" {
  if (!session.sources.personalOwnerUserId) return "none";
  return session.isChildSession ? "pinned" : "all";
}

/** Only the personal owner's own sessions may write to their personal store. */
export function canWritePersonal(session: MemorySession): boolean {
  const owner = session.sources.personalOwnerUserId;
  return owner !== null && session.principal.userId === owner;
}
