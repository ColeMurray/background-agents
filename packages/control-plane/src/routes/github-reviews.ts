/**
 * Internal routes for GitHub review-generation supersession (design:
 * review-supersede, fix A).
 *
 * The github-bot claims a monotonically increasing generation per
 * (repoId, prNumber) before creating a review session, then — once its own
 * session is admitted — sweeps every session from an older generation:
 * cancelling the stale session's DO and its active descendants so at most
 * one review session per PR is ever running. The claim, release-claim, and
 * sweep routes are gated to the github-bot service principal; the
 * review-ownership pair is the review agent's own submission-lease boundary
 * and is gated to the calling session's sandbox principal.
 */

import { Hono } from "hono";
import { z } from "zod";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  GITHUB_SERVICE_ROUTE,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  serviceAuthorized,
  type RequestContext,
} from "./shared";
import { dispatchSession, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:github-reviews");

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
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(request, claimRequestSchema, "Invalid claim request body");
  if (parsed instanceof Response) return parsed;
  const { repoId, prNumber } = parsed;

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
 * POST /internal/github-reviews/release-claim
 * Compensating counterpart to the claim: rolls `latest_generation` back by one
 * when the github-bot's own session creation failed for a reason other than
 * supersession, so the bump it made does not permanently outrank a review
 * session that is still running from the previous generation.
 *
 * Conditional by construction — the update lands only while the caller's
 * generation is still the latest. A newer trigger that has already claimed
 * past it wins, and its claim is left untouched.
 */
export async function handleReleaseReviewGeneration(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(request, sweepRequestSchema, "Invalid release request body");
  if (parsed instanceof Response) return parsed;
  const { repoId, prNumber, generation } = parsed;

  const result = await ctx.db
    .prepare(
      `UPDATE github_review_state
         SET latest_generation = latest_generation - 1, updated_at = ?
       WHERE repo_id = ? AND pr_number = ? AND latest_generation = ?
         AND NOT EXISTS (
           SELECT 1 FROM github_review_sessions grs
           WHERE grs.repo_id = github_review_state.repo_id
             AND grs.pr_number = github_review_state.pr_number
             AND grs.generation = ?
         )`
    )
    .bind(Date.now(), repoId, prNumber, generation, generation)
    .run();

  const released = (result.meta?.changes ?? 0) > 0;
  logger.info("review_claim.release", {
    event: "review_claim.release",
    repo_id: repoId,
    pull_number: prNumber,
    generation,
    released,
  });
  return json({ released });
}

type StaleReviewCancellationOutcome = "cancelled" | "deferred" | "failed";

/**
 * Cancel one stale review session's DO plus its active descendants
 * (mirroring handleCancelChild's cascade in routes/session-children.ts).
 *
 * `cancelled` means the fence row may be deleted, `deferred` means a normal
 * lease or initialization window retained it for a later sweep, and `failed`
 * means cancellation was attempted but did not reach a terminal state.
 */
async function cancelStaleReviewSession(
  ctx: Pick<SessionRouteContext, "sessionRuntime">,
  sessionStore: SessionIndexStore,
  row: StaleReviewSessionRow
): Promise<StaleReviewCancellationOutcome> {
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
    return "deferred";
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
      return "deferred";
    }
    logger.warn("review_sweep.orphan_404", {
      event: "review_sweep.orphan_404",
      session_id: sessionId,
      age_ms: ageMs,
    });
    return "cancelled";
  }
  if (!response.ok && response.status !== 409) return "failed";

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
  return descendantsCancelled ? "cancelled" : "failed";
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
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, sweepRequestSchema, "Invalid sweep request body");
  if (parsed instanceof Response) return parsed;
  const { repoId, prNumber, generation } = parsed;

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
  const deferredSessionIds: string[] = [];
  const failedSessionIds: string[] = [];

  for (const row of stale.results) {
    const sessionId = row.session_id;
    let outcome: StaleReviewCancellationOutcome;
    try {
      outcome = await cancelStaleReviewSession(ctx, sessionStore, row);
    } catch (cancelError) {
      // A thrown DO transport or D1 error must not abort the sweep: report
      // this session as failed (row retained for the next sweep) and keep
      // going — later stale sessions still need cancelling.
      logger.warn("review_sweep.cancel_threw", {
        event: "review_sweep.cancel_threw",
        session_id: sessionId,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
      outcome = "failed";
    }
    if (outcome === "deferred") {
      deferredSessionIds.push(sessionId);
      continue;
    }
    if (outcome === "failed") {
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

  return json({ cancelledSessionIds, deferredSessionIds, failedSessionIds });
}

/**
 * POST /sessions/:id/review-ownership
 * Sandbox-token-authenticated ownership check and lease acquisition: the
 * review agent calls this
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const sessionId = params.id;
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const sessionId = params.id;
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
  db: SqlDatabase,
  sessionRuntime: SessionRuntimeClient
): Promise<void> {
  const stale = await db
    .prepare(
      `SELECT grs.session_id, grs.created_at, st.lease_session_id, st.lease_expires_at
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.generation < st.latest_generation
       ORDER BY grs.created_at ASC, grs.session_id ASC
       LIMIT 20`
    )
    .all<StaleReviewSessionRow>();
  if (stale.results.length === 0) return;

  const sessionStore = new SessionIndexStore(db);
  for (const row of stale.results) {
    let outcome: StaleReviewCancellationOutcome;
    try {
      outcome = await cancelStaleReviewSession({ sessionRuntime }, sessionStore, row);
    } catch (cancelError) {
      logger.warn("review_reaper.cancel_threw", {
        event: "review_reaper.cancel_threw",
        session_id: row.session_id,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
      continue;
    }
    if (outcome !== "cancelled") continue;
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

export const githubReviewRoutes = new Hono<ControlPlaneHonoEnv>();

// Internal fence routes: admission narrows them to the verified github-bot
// service principal, so no handler-level guard is needed.
githubReviewRoutes.post(
  "/internal/github-reviews/claim",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatch(c, handleClaimReviewGeneration)
);

githubReviewRoutes.post(
  "/internal/github-reviews/release-claim",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatch(c, handleReleaseReviewGeneration)
);

githubReviewRoutes.post(
  "/internal/github-reviews/sweep",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatchSession(c, handleSweepStaleReviews)
);

// Submission-boundary fence, called by the review agent from the sandbox.
// Both handlers additionally require the caller's own sandbox principal.
githubReviewRoutes.post(
  "/sessions/:id/review-ownership",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleReviewOwnership)
);

githubReviewRoutes.delete(
  "/sessions/:id/review-ownership",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleReviewLeaseRelease)
);
