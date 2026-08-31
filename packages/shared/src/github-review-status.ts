/**
 * The GitHub commit-status contract for an Open-Inspect review.
 *
 * Two workers write this status and they must agree on its context string, or
 * a write from one lands beside the other's rather than replacing it: the
 * github-bot posts `pending` when a review starts and the terminal status when
 * the agent finishes, and the control plane closes out a review whose session
 * died before the agent could write anything. The context lives here because a
 * copy in each package is a string that can drift silently — the symptom being
 * a PR carrying two `open-inspect` statuses, one of them pending forever.
 */

/** The `context` every Open-Inspect review status is posted under. */
export const REVIEW_STATUS_CONTEXT = "open-inspect";

export const REVIEW_PENDING_DESCRIPTION = "Review in progress";

/**
 * Written by the control plane when a review session reached a terminal state
 * without its agent posting anything, or sat pending past
 * `REVIEW_STALE_PENDING_MS`.
 *
 * Deliberately says the review did not run rather than that it failed: a
 * reviewer who reads "Review failed" looks for findings, and there are none —
 * the process died. The remedy is to push again, so the description says so.
 */
export const REVIEW_ABANDONED_DESCRIPTION = "Review did not run — push again to retry";

/**
 * How long an `open-inspect` status may sit `pending` before the control plane
 * treats it as abandoned and closes it out.
 *
 * A review session that dies of a supervisor timeout runs no code of its own,
 * so nothing inside it can report the ending; only elapsed time distinguishes a
 * dead review from a slow one. Measured healthy reviews complete in 100-620s of
 * active time, so twenty minutes clears the slowest by a wide margin while
 * still resolving the check inside the window someone would wait through.
 */
export const REVIEW_STALE_PENDING_MS = 20 * 60 * 1000;
