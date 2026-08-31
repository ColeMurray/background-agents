/**
 * Internal routes for GitHub review-generation supersession (design:
 * review-supersede, fix A).
 *
 * The github-bot claims a monotonically increasing generation per
 * (repoId, prNumber) before creating a review session, then — once its own
 * session is admitted — sweeps every session from an older generation:
 * cancelling the stale session's DO and its active descendants so at most
 * one review session per PR is ever running. Both routes are gated to the
 * github-bot service principal.
 */

import {
  REVIEW_ABANDONED_DESCRIPTION,
  REVIEW_STALE_PENDING_MS,
  REVIEW_STATUS_CONTEXT,
} from "@open-inspect/shared";
import { z } from "zod";
import { getCachedInstallationToken, getGitHubAppConfig } from "../auth/github-app";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import {
  defineRoute,
  defineRoutes,
  error,
  GITHUB_SERVICE_ROUTE,
  json,
  NO_AUTHORIZATION,
  parseJsonBody,
  parsePattern,
  serviceAuthorized,
  type RequestContext,
  type Route,
  type RoutePolicy,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:github-reviews");
/** Identifies this worker on the status writes it makes on a dead review's behalf. */
const CONTROL_PLANE_USER_AGENT = "open-inspect-control-plane";
const GITHUB_REVIEW_SANDBOX_ROUTE = {
  authentication: {
    kind: "sandbox",
    getSessionId: (match: RegExpMatchArray) => match.groups?.id ?? null,
  },
  supportedScmProviders: ["github"],
} as const satisfies RoutePolicy;

const claimRequestSchema = z.object({
  repoId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
});

const sweepRequestSchema = z.object({
  repoId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  generation: z.number().int().positive(),
});

interface StaleReviewSessionRow {
  session_id: string;
  created_at: number;
  /** Current leaseholder for the row's PR, when a lease is held. */
  lease_session_id: string | null;
  lease_expires_at: number | null;
}

/**
 * How old a fence row must be before a 404 from its session DO proves a true
 * orphan (fence inserted, init crashed before the DO existed). Younger rows
 * may belong to a create still in flight — its DO init hasn't run yet — so a
 * 404 is inconclusive and the row must be retained for a later sweep or the
 * creator's own post-init supersession check (initialize.ts Step 4).
 */
const REVIEW_FENCE_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * How long a submission lease defers cancellation of its holder. Claims are
 * never blocked by a lease — it only serializes the WRITE boundary: sweeps
 * and the reaper skip a session holding an unexpired lease so a cancel can
 * never race its in-flight GitHub POSTs, and a successor agent cannot
 * acquire until release/expiry. The agent releases explicitly right after
 * its writes; the TTL only bounds a crashed leaseholder.
 */
export const REVIEW_SUBMISSION_LEASE_MS = 2 * 60 * 1000;

/**
 * POST /internal/github-reviews/claim
 * Atomically bumps (or seeds) the latest claimed generation for a PR and
 * returns it. The github-bot embeds the returned generation in the review
 * session it is about to create; a session-create fence (initialize.ts)
 * rejects the create if a concurrent claim has since moved the generation
 * on. An active submission lease is intentionally preserved: the superseded
 * leaseholder may finish its in-flight GitHub write, while the new
 * generation's own lease acquisition (minutes away, after its review work)
 * waits on release/expiry.
 */
export async function handleClaimReviewGeneration(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;
  const parsed = claimRequestSchema.safeParse(rawBody);
  if (!parsed.success) return error("Invalid claim request body", 400);
  const { repoId, prNumber } = parsed.data;

  const row = await ctx.db
    .prepare(
      `INSERT INTO github_review_state (repo_id, pr_number, latest_generation, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(repo_id, pr_number) DO UPDATE SET
         latest_generation = latest_generation + 1,
         updated_at = excluded.updated_at
       RETURNING latest_generation`
    )
    .bind(repoId, prNumber, Date.now())
    .first<{ latest_generation: number }>();

  if (!row) {
    // INSERT..ON CONFLICT..RETURNING always yields a row; this is unreachable
    // absent an engine bug, kept as a defensive 500 rather than a thrown 500.
    return error("Failed to claim review generation", 500);
  }

  return json({ generation: row.latest_generation });
}

/**
 * Cancel one stale review session's DO plus its active descendants
 * (mirroring handleCancelChild's cascade in routes/session-children.ts).
 * Returns whether the caller may delete the github_review_sessions row:
 * true when the session (and every descendant) reached a terminal state —
 * 2xx, 409 (already terminal), or 404 on a row older than
 * REVIEW_FENCE_ORPHAN_GRACE_MS (DO never initialized: a crashed create).
 * False on any other failure — including a 404 on a fresh row, whose create
 * may still be mid-init — so a later sweep retries.
 */
async function cancelStaleReviewSession(
  ctx: SessionRouteContext,
  sessionStore: SessionIndexStore,
  row: StaleReviewSessionRow
): Promise<boolean> {
  const sessionId = row.session_id;
  // An unexpired submission lease defers cancellation entirely: the holder
  // is mid-GitHub-write, and a cancel cannot fence an in-flight POST. The
  // retained row is retried by the next sweep or the minute reaper after
  // release/expiry.
  if (
    row.lease_session_id === sessionId &&
    row.lease_expires_at !== null &&
    row.lease_expires_at >= Date.now()
  ) {
    logger.info("review_sweep.lease_deferred", {
      event: "review_sweep.lease_deferred",
      session_id: sessionId,
      lease_expires_at: row.lease_expires_at,
    });
    return false;
  }
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.cancel, {
    method: "POST",
  });
  if (response.status === 404) {
    const ageMs = Date.now() - row.created_at;
    if (ageMs < REVIEW_FENCE_ORPHAN_GRACE_MS) {
      logger.warn("review_sweep.orphan_pending", {
        event: "review_sweep.orphan_pending",
        session_id: sessionId,
        age_ms: ageMs,
      });
      return false;
    }
    logger.warn("review_sweep.orphan_404", {
      event: "review_sweep.orphan_404",
      session_id: sessionId,
      age_ms: ageMs,
    });
    return true;
  }
  if (!response.ok && response.status !== 409) return false;

  const descendantIds = await sessionStore.listActiveDescendantIds(sessionId);
  let descendantsCancelled = true;
  for (const descendantId of descendantIds) {
    const descendantResponse = await ctx.sessionRuntime.fetch(
      descendantId,
      SessionInternalPaths.cancel,
      { method: "POST" }
    );
    // 409 means the descendant reached a terminal state since the D1 query.
    if (!descendantResponse.ok && descendantResponse.status !== 409) {
      descendantsCancelled = false;
    }
  }
  return descendantsCancelled;
}

/**
 * POST /internal/github-reviews/sweep
 * Cancels every review session from a generation older than the caller's,
 * for the same PR, then drops the rows for the ones it successfully
 * cancelled. Always 200, even with partial failures — sweep failure must
 * never block the review session that triggered it.
 */
export async function handleSweepStaleReviews(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;
  const parsed = sweepRequestSchema.safeParse(rawBody);
  if (!parsed.success) return error("Invalid sweep request body", 400);
  const { repoId, prNumber, generation } = parsed.data;

  const stale = await ctx.db
    .prepare(
      `SELECT grs.session_id, grs.created_at, st.lease_session_id, st.lease_expires_at
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.repo_id = ? AND grs.pr_number = ? AND grs.generation < ?`
    )
    .bind(repoId, prNumber, generation)
    .all<StaleReviewSessionRow>();

  const sessionStore = new SessionIndexStore(ctx.db);
  const cancelledSessionIds: string[] = [];
  const failedSessionIds: string[] = [];

  for (const row of stale.results) {
    const sessionId = row.session_id;
    let cancelled: boolean;
    try {
      cancelled = await cancelStaleReviewSession(ctx, sessionStore, row);
    } catch (cancelError) {
      // A thrown DO transport or D1 error must not abort the sweep: report
      // this session as failed (row retained for the next sweep) and keep
      // going — later stale sessions still need cancelling.
      logger.warn("review_sweep.cancel_threw", {
        event: "review_sweep.cancel_threw",
        session_id: sessionId,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
      cancelled = false;
    }
    if (!cancelled) {
      failedSessionIds.push(sessionId);
      continue;
    }
    cancelledSessionIds.push(sessionId);
    await ctx.db
      .prepare(
        `DELETE FROM github_review_sessions WHERE repo_id = ? AND pr_number = ? AND session_id = ?`
      )
      .bind(repoId, prNumber, sessionId)
      .run();
  }

  return json({ cancelledSessionIds, failedSessionIds });
}

/**
 * GET /sessions/:id/review-ownership
 * Sandbox-token-authenticated ownership check: the review agent calls this
 * immediately before its final GitHub writes. `owned` is true only while the
 * calling session's registered generation is still the latest claimed one
 * for its PR — a superseded (or swept) session gets false and must exit
 * without posting. This is the submission-boundary fence that cancellation
 * alone cannot provide: a same-head successor passes the prompt's head-SHA
 * check, but never this one.
 */
export async function handleReviewOwnership(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  if (ctx.principal?.kind !== "sandbox" || ctx.principal.sessionId !== sessionId) {
    return error("Unauthorized", 401);
  }

  // Atomic ownership check + lease acquisition in one statement: the update
  // lands only while the caller's registered generation is still the latest
  // AND no other session holds an unexpired lease. Re-acquiring one's own
  // lease is allowed (idempotent retry of the submission chain).
  const now = Date.now();
  const result = await ctx.db
    .prepare(
      `UPDATE github_review_state SET lease_session_id = ?, lease_expires_at = ?
       WHERE EXISTS (
         SELECT 1 FROM github_review_sessions grs
         WHERE grs.session_id = ?
           AND grs.repo_id = github_review_state.repo_id
           AND grs.pr_number = github_review_state.pr_number
           AND grs.generation = github_review_state.latest_generation
       )
       AND (lease_session_id IS NULL OR lease_session_id = ? OR lease_expires_at < ?)`
    )
    .bind(sessionId, now + REVIEW_SUBMISSION_LEASE_MS, sessionId, sessionId, now)
    .run();

  // 204 vs 409 rather than a JSON body: the agent-side check is plain
  // `curl -f`, which mechanically fails closed on 409 — no response parsing
  // for the model to get wrong.
  if ((result.meta?.changes ?? 0) > 0) {
    return new Response(null, { status: 204 });
  }
  return error("Review generation superseded", 409);
}

/**
 * DELETE /sessions/:id/review-ownership
 * Best-effort lease release right after the agent's GitHub writes, so a new
 * claim never waits out the full TTL on the happy path. Only the current
 * leaseholder's release clears the lease; anyone else's is a no-op 204.
 */
export async function handleReviewLeaseRelease(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  if (ctx.principal?.kind !== "sandbox" || ctx.principal.sessionId !== sessionId) {
    return error("Unauthorized", 401);
  }

  await ctx.db
    .prepare(
      `UPDATE github_review_state SET lease_session_id = NULL, lease_expires_at = NULL
       WHERE lease_session_id = ?`
    )
    .bind(sessionId)
    .run();

  return new Response(null, { status: 204 });
}

/**
 * Cron-driven reaper: retries the cancellation of every superseded review
 * session whose fence row survived its sweep (cancel unconfirmed, fresh-404
 * grace, or a creator's failed self-cancel). Runs from the Worker's minute
 * cron so retained rows have a durable retry owner that does not depend on
 * another PR event ever arriving. Row-deletion rules match the sweep's.
 */
export async function reapSupersededReviewSessions(
  db: RequestContext["db"],
  sessionRuntime: SessionRouteContext["sessionRuntime"]
): Promise<void> {
  const stale = await db
    .prepare(
      `SELECT grs.session_id, grs.created_at, st.lease_session_id, st.lease_expires_at
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.generation < st.latest_generation
       LIMIT 20`
    )
    .all<StaleReviewSessionRow>();
  if (stale.results.length === 0) return;

  const sessionStore = new SessionIndexStore(db);
  for (const row of stale.results) {
    let cancelled: boolean;
    try {
      cancelled = await cancelStaleReviewSession(
        { db, sessionRuntime } as SessionRouteContext,
        sessionStore,
        row
      );
    } catch (cancelError) {
      logger.warn("review_reaper.cancel_threw", {
        event: "review_reaper.cancel_threw",
        session_id: row.session_id,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
      continue;
    }
    if (!cancelled) continue;
    await db
      .prepare(`DELETE FROM github_review_sessions WHERE session_id = ?`)
      .bind(row.session_id)
      .run();
    logger.info("review_reaper.reaped", {
      event: "review_reaper.reaped",
      session_id: row.session_id,
    });
  }
}

export const githubReviewRoutes: Route[] = [
  defineRoute(GITHUB_SERVICE_ROUTE, {
    method: "POST",
    pattern: parsePattern("/internal/github-reviews/claim"),
    authorization: serviceAuthorized("github-bot"),
    handler: handleClaimReviewGeneration,
  }),
  defineRoute(
    GITHUB_SERVICE_ROUTE,
    sessionRoute({
      method: "POST",
      pattern: parsePattern("/internal/github-reviews/sweep"),
      authorization: serviceAuthorized("github-bot"),
      handler: handleSweepStaleReviews,
    })
  ),
  ...defineRoutes(GITHUB_REVIEW_SANDBOX_ROUTE, [
    {
      method: "GET",
      pattern: parsePattern("/sessions/:id/review-ownership"),
      authorization: NO_AUTHORIZATION,
      handler: handleReviewOwnership,
    },
    {
      method: "DELETE",
      pattern: parsePattern("/sessions/:id/review-ownership"),
      authorization: NO_AUTHORIZATION,
      handler: handleReviewLeaseRelease,
    },
  ]),
];

/** A review row whose session can no longer post its own commit status. */
interface DeadReviewSessionRow {
  session_id: string;
  repo_id: number;
  pr_number: number;
  head_sha: string;
  created_at: number;
  status: string;
  repo_owner: string | null;
  repo_name: string | null;
  lease_session_id: string | null;
  lease_expires_at: number | null;
}

/**
 * Post the abandoned status for one review, replacing the pending one the
 * github-bot wrote when the review started.
 *
 * Returns false when the write did not land, so the row is retained and the
 * next tick retries rather than leaving the PR pending with nothing tracking it.
 */
async function postAbandonedReviewStatus(env: Env, row: DeadReviewSessionRow): Promise<boolean> {
  if (!row.repo_owner || !row.repo_name) return false;
  const config = getGitHubAppConfig(env);
  if (!config) return false;
  const token = await getCachedInstallationToken(config, { userAgent: CONTROL_PLANE_USER_AGENT });
  const response = await fetch(
    `https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/statuses/${row.head_sha}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": CONTROL_PLANE_USER_AGENT,
      },
      body: JSON.stringify({
        state: "error",
        context: REVIEW_STATUS_CONTEXT,
        description: REVIEW_ABANDONED_DESCRIPTION,
      }),
    }
  );
  // A 422 is GitHub refusing the sha itself — a force-push dropped it, so there
  // is no commit left to describe. Treated as done rather than retried forever.
  return response.ok || response.status === 422;
}

/**
 * Close out reviews whose session can no longer speak for itself.
 *
 * The github-bot writes `pending` when a review starts and the agent writes the
 * terminal status when it finishes. A session killed by a supervisor timeout
 * runs no code of its own, so it writes neither — and a pending status is
 * indistinguishable from a review still running, so the check never resolves
 * and any merge rule keyed on it waits forever.
 *
 * Two conditions, because a session can fail in two ways this cannot tell apart
 * from the outside: it reached a terminal status, or it sat pending past
 * `REVIEW_STALE_PENDING_MS` without reaching one at all. The second is the case
 * the first cannot cover — a session whose runtime died before recording
 * anything leaves a row that no status transition will ever resolve.
 *
 * Superseded rows are `reapSupersededReviewSessions`' job and are left alone
 * here: that path cancels the session first, and cancelling then closing out in
 * one tick would post twice for one head.
 */
export async function closeOutDeadReviewSessions(
  db: RequestContext["db"],
  env: Env
): Promise<void> {
  if (!getGitHubAppConfig(env)) return;
  const cutoff = Date.now() - REVIEW_STALE_PENDING_MS;
  const dead = await db
    .prepare(
      `SELECT grs.session_id, grs.repo_id, grs.pr_number, grs.head_sha, grs.created_at,
              s.status, s.repo_owner, s.repo_name,
              st.lease_session_id, st.lease_expires_at
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       JOIN sessions s ON s.id = grs.session_id
       WHERE grs.generation = st.latest_generation
         AND (s.status IN ('failed', 'cancelled') OR grs.created_at < ?1)
       LIMIT 20`
    )
    .bind(cutoff)
    .all<DeadReviewSessionRow>();

  for (const row of dead.results) {
    // An unexpired submission lease means the holder is mid-GitHub-write, and a
    // status posted now would race the verdict it is about to publish. The row
    // is retained and retried once the lease lapses — the same deferral
    // `cancelStaleReviewSession` makes, and for the same reason.
    if (
      row.lease_session_id === row.session_id &&
      row.lease_expires_at !== null &&
      row.lease_expires_at >= Date.now()
    ) {
      continue;
    }
    let posted: boolean;
    try {
      posted = await postAbandonedReviewStatus(env, row);
    } catch (postError) {
      logger.warn("review_closeout.post_threw", {
        event: "review_closeout.post_threw",
        session_id: row.session_id,
        error: postError instanceof Error ? postError.message : String(postError),
      });
      continue;
    }
    if (!posted) continue;
    await db
      .prepare(`DELETE FROM github_review_sessions WHERE session_id = ?`)
      .bind(row.session_id)
      .run();
    logger.info("review_closeout.closed", {
      event: "review_closeout.closed",
      session_id: row.session_id,
      repo_id: row.repo_id,
      pull_number: row.pr_number,
      session_status: row.status,
      age_ms: Date.now() - row.created_at,
    });
  }
}
