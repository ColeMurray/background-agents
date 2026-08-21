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

import type { SessionInboxCategory } from "./session-inbox";
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

/**
 * The inactive statuses as SQL string literals, for the queries that filter on
 * them. Generated from the same set the predicate uses so a change to one
 * cannot leave the other behind.
 */
export const INACTIVE_SESSION_STATUS_SQL = [...INACTIVE_SESSION_STATUSES]
  .map((status) => `'${status}'`)
  .join(", ");

/**
 * A session's inbox grouping, folded over the session and all its descendants.
 *
 * Deliberately takes a collection: a root's category depends on every session
 * in its tree, because the query this mirrors aggregates with MAX() over the
 * group. A per-session signature could not express the rule.
 *
 * This does not replace the SQL in `session-inbox-store.ts` — that aggregate
 * has to stay for pagination to work. It exists so the rule has one typed,
 * testable definition to check the query against, instead of living only as a
 * CASE expression inside a query string.
 *
 * Order matters: unread wins over in-progress. A session that is both needs
 * the user's attention more than it needs a progress indicator.
 *
 * Archived sessions contribute nothing — not their status and not their unread
 * flag. The query filters them in its eligibility clause, before the aggregate
 * ever runs, so a fold that counted them would report `needs_attention` for a
 * root whose only unread descendant is archived while production reported
 * `finished`. The conformance test covers both archived shapes precisely
 * because they are the only ones that can catch this.
 *
 * This is an oracle, not a runtime path: the SQL aggregate stays, because
 * pagination needs it. The function exists so the rule has one readable,
 * testable statement to check that query against.
 */
export function deriveInboxCategory(
  tree: ReadonlyArray<{ status: SessionStatus; unread: boolean }>
): SessionInboxCategory {
  const eligible = tree.filter((session) => session.status !== "archived");
  if (eligible.some((session) => session.unread)) return "needs_attention";
  if (eligible.some((session) => session.status === "active")) return "in_progress";
  return "finished";
}

/**
 * The session status transitions the system actually performs.
 *
 * Derived from the code, not from intuition. That distinction is load-bearing:
 * an earlier draft of this table forbade `created -> completed`, which the
 * abandoned-draft repair performs and an integration test asserts, so
 * enforcing it would have broken the sweep on exactly the rows it exists to
 * unstick. Every entry below has a named cause in the transition tests.
 *
 * Same-status entries are omitted because `transition()` short-circuits when
 * nothing changes; `isLegalSessionTransition` permits them separately.
 */
export const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  // A draft can be prompted, repaired to a settled status by the expire-draft
  // sweep, filed away, or cancelled before it ever runs.
  created: ["active", "completed", "failed", "archived", "cancelled"],
  // `active -> created` is intentional, not a bug: cancelling the only pending
  // prompt deletes its row, leaving a session with no messages at all, and
  // returning it to draft is what lets the 8-hour sweep reclaim it. It was
  // added deliberately after dead sessions accumulated. Do not remove it.
  active: ["completed", "failed", "cancelled", "archived", "created"],
  completed: ["active", "archived"],
  failed: ["active", "archived"],
  // Absorbing by design. Four places agree independently:
  // isPromptableSessionStatus, the archive guard, the unarchive guard, and the
  // web prompt composer. Users stop a prompt; they do not cancel a session --
  // there is no public route to cancel one, only to cancel a child.
  cancelled: [],
  // Unarchive settles from message state rather than asserting `active`, so
  // every status that settle can produce is reachable from here -- except
  // `active`. Archiving refuses while any message is pending or processing, and
  // an archived session is not promptable, so an archived session always has
  // zero queued work and the settle can only yield completed, failed, or
  // created. An integration test that tried to reach `active` this way got a
  // 409 from the archive step, which is what pinned this down.
  archived: ["completed", "failed", "created"],
};

/**
 * Whether `from -> to` is a transition the system is known to perform.
 *
 * A no-op is always legal: callers routinely re-assert the current status, and
 * `transition()` short-circuits those before any write.
 */
export function isLegalSessionTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || SESSION_TRANSITIONS[from].includes(to);
}
