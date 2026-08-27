/**
 * Predicates over `SessionStatus`, named for the question each one answers.
 *
 * These used to live as four separate `TERMINAL_STATUSES` constants — three in
 * the control plane, one an untyped `Set<string>` in the web package. Three of
 * the four held identical members, so the duplication bought nothing and could
 * only drift; the fourth held a genuinely different set, and shared a name with
 * the others anyway. A reader could not tell which disagreements were
 * deliberate.
 *
 * The rule going forward: a predicate here is named for its question, not for
 * the shape of its answer. Two predicates may legitimately return different
 * answers — see `isTurnSettled` vs `isSessionInactive` — but that difference
 * must be visible in the names.
 */

import type { SessionStatus } from "./sessions";

/**
 * Statuses in which a session is no longer live work.
 *
 * Asked by child-session accounting (does this parent still have running
 * descendants?), by the cancel guard (there is nothing left to cancel), and by
 * the sidebar's child-activity indicator.
 */
const INACTIVE_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "completed",
  "failed",
  "archived",
  "cancelled",
]);

/**
 * Statuses that end a turn and therefore settle its metrics.
 *
 * Deliberately excludes `archived`: archiving is a filing action taken on an
 * already-idle session, so no execution completed and there are no new metrics
 * to sync. This is the one place the two predicates diverge, and the divergence
 * is asserted in the tests so it cannot be quietly widened.
 */
const TURN_SETTLED_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isSessionInactive(status: SessionStatus): boolean {
  return INACTIVE_SESSION_STATUSES.has(status);
}

export function isTurnSettled(status: SessionStatus): boolean {
  return TURN_SETTLED_STATUSES.has(status);
}

/** Whether a session accepts follow-up work and the sandbox needed to run it. */
export function isSessionPromptable(status: SessionStatus): boolean {
  switch (status) {
    case "created":
    case "active":
    case "completed":
    case "failed":
      return true;
    case "archived":
    case "cancelled":
      return false;
  }
}

/**
 * The inactive statuses as SQL string literals, for the queries that filter on
 * them. Generated from the same set the predicate uses so a change to one
 * cannot leave the other behind.
 */
export const INACTIVE_SESSION_STATUS_SQL = [...INACTIVE_SESSION_STATUSES]
  .map((status) => `'${status}'`)
  .join(", ");
