/**
 * Internal routes for GitHub review-generation supersession (design:
 * review-supersede, fix A).
 *
 * The github-bot claims a monotonically increasing generation per
 * (repoId, prNumber) before creating a review session, then — once its own
 * session is admitted — sweeps every session from an older generation:
 * cancelling the stale session's DO and its active descendants so at most
 * one review session per PR is ever running.
 *
 * Ownership of a review's terminal `open-inspect` commit status: the only
 * token that permits writing one is the PR's submission lease in
 * github_review_state (one slot per PR). An agent takes it under its own
 * session id, only while its session is the latest generation and its turn
 * has not been closed out. A close-out takes it under `close-out:<sessionId>`,
 * only while that session's fence row is the newest row for its head. The
 * only unleased status write is the admitting handler's "pending".
 *
 * The claim, release-claim, sweep, and close-out routes are gated to the
 * github-bot service principal; the review-ownership pair is the review
 * agent's own submission-lease boundary and is gated to the calling session's
 * sandbox principal.
 */

import { Hono } from "hono";
import { z } from "zod";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
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

const releaseRequestSchema = z.object({
  repoId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  generation: z.number().int().positive(),
});

/**
 * `owner`/`repo` name where the review's commit status lives. Optional so a
 * bot that predates close-out requests keeps the old sweep behavior.
 */
const sweepRequestSchema = releaseRequestSchema.extend({
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
});

/** Stored in github_review_sessions.close_out_request once a review's turn has ended. */
const closeOutRequestSchema = z.object({
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  description: z.string().nullable(),
});

type CloseOutRequest = z.infer<typeof closeOutRequestSchema>;

const closeOutBodySchema = z.object({
  sessionId: z.string().trim().min(1),
  request: closeOutRequestSchema.optional(),
});

const closeOutFinalizeBodySchema = z.object({
  sessionId: z.string().trim().min(1),
  outcome: z.enum(["done", "retry"]),
});

interface StaleReviewSessionRow {
  session_id: string;
  created_at: number;
  /** Current leaseholder for the row's PR, when a lease is held. */
  lease_session_id: string | null;
  lease_expires_at: number | null;
}

/** Lease holder id for a close-out of `sessionId`; never equal to any session id. */
function closeOutHolder(sessionId: string): string {
  return `close-out:${sessionId}`;
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
 * How long a submission lease is held. Claims are never blocked by a lease —
 * it only serializes the terminal status write: sweeps and the reaper skip a
 * session holding an unexpired lease so a cancel can never race its in-flight
 * GitHub POSTs, and every other agent or close-out waits for release/expiry.
 * Holders release explicitly right after their writes; the TTL only bounds a
 * crashed holder.
 */
export const REVIEW_SUBMISSION_LEASE_MS = 2 * 60 * 1000;

/**
 * Age past which the reaper drops a fence row outright: far beyond a review
 * session's sandbox lifetime (two hours by default), so no live review owns a
 * row this old. It bounds a close-out that can never succeed, and the
 * head-of-line blocking it would cause.
 */
const REVIEW_FENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Rows the reaper handles per pass, so one tick stays bounded. */
const REAPER_STALE_BATCH = 20;
const REAPER_CLOSE_OUT_BATCH = 10;

/** Timeout for one reaper-driven close-out request to the github-bot. */
const CLOSE_OUT_DRIVE_TIMEOUT_MS = 10_000;

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
  const parsed = await parseBody(request, releaseRequestSchema, "Invalid release request body");
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

type StaleReviewCancellationOutcome = "cancelled" | "orphaned" | "deferred" | "failed";

/**
 * Cancel one stale review session's DO plus its active descendants
 * (mirroring handleCancelChild's cascade in routes/session-children.ts).
 *
 * `cancelled` means the session reached a terminal state; `orphaned` means
 * its DO never existed (so no status was ever posted for it) and the fence
 * row can go; `deferred` means a normal lease or initialization window
 * retained it for a later attempt; and `failed` means cancellation was
 * attempted but did not reach a terminal state.
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
    return "orphaned";
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

interface SweptReviewSessionRow extends StaleReviewSessionRow {
  close_out_request: string | null;
  /** 1 when no newer review is registered on this row's head, so its status is still its own. */
  head_unclaimed: number;
}

/**
 * POST /internal/github-reviews/sweep
 * Cancels every review session from a generation older than the caller's,
 * for the same PR. Always 200, even with partial failures — sweep failure
 * must never block the review session that triggered it.
 *
 * A stale review whose head no newer review has claimed (a push replaced it)
 * still owns that head's status. When the caller names the repository, such
 * a row gets a close-out request and is kept: it is closed out under the
 * lease like any ended review — by its own completion callback, or the
 * reaper — and only a close-out deletes it. Every other stale row is deleted
 * once cancelled: its head's status belongs to the newer review.
 */
export async function handleSweepStaleReviews(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, sweepRequestSchema, "Invalid sweep request body");
  if (parsed instanceof Response) return parsed;
  const { repoId, prNumber, generation, owner, repo } = parsed;
  const closeOutRequest: CloseOutRequest | null =
    owner && repo ? { owner, repo, description: null } : null;

  const stale = await ctx.db
    .prepare(
      `SELECT grs.session_id, grs.created_at, grs.close_out_request,
         st.lease_session_id, st.lease_expires_at,
         NOT EXISTS (
           SELECT 1 FROM github_review_sessions newer
           WHERE newer.repo_id = grs.repo_id AND newer.pr_number = grs.pr_number
             AND newer.generation > grs.generation AND newer.head_sha = grs.head_sha
         ) AS head_unclaimed
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.repo_id = ? AND grs.pr_number = ? AND grs.generation < ?`
    )
    .bind(repoId, prNumber, generation)
    .all<SweptReviewSessionRow>();

  const sessionStore = new SessionIndexStore(ctx.db);
  const cancelledSessionIds: string[] = [];
  const deferredSessionIds: string[] = [];
  const failedSessionIds: string[] = [];

  for (const row of stale.results) {
    const sessionId = row.session_id;
    const owesCloseOut =
      row.head_unclaimed === 1 && (closeOutRequest !== null || row.close_out_request !== null);
    let outcome: StaleReviewCancellationOutcome;
    try {
      if (owesCloseOut && closeOutRequest) {
        await recordCloseOutRequest(ctx.db, sessionId, closeOutRequest);
      }
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
    if (owesCloseOut && outcome === "cancelled") continue;
    await ctx.db
      .prepare(
        `DELETE FROM github_review_sessions WHERE repo_id = ? AND pr_number = ? AND session_id = ?`
      )
      .bind(repoId, prNumber, sessionId)
      .run();
  }

  return json({ cancelledSessionIds, deferredSessionIds, failedSessionIds });
}

/** Record that a review's turn has ended; the first request's details win. */
async function recordCloseOutRequest(
  db: SqlDatabase,
  sessionId: string,
  request: CloseOutRequest
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_review_sessions SET close_out_request = COALESCE(close_out_request, ?)
       WHERE session_id = ?`
    )
    .bind(JSON.stringify(request), sessionId)
    .run();
}

interface CloseOutRow extends StaleReviewSessionRow {
  repo_id: number;
  pr_number: number;
  generation: number;
  head_sha: string;
  close_out_request: string | null;
  latest_generation: number;
  /** 1 when a newer review is registered on this row's head: that status is no longer this row's. */
  head_reclaimed: number;
}

async function loadCloseOutRow(db: SqlDatabase, sessionId: string): Promise<CloseOutRow | null> {
  return db
    .prepare(
      `SELECT grs.session_id, grs.repo_id, grs.pr_number, grs.generation, grs.head_sha,
         grs.created_at, grs.close_out_request,
         st.latest_generation, st.lease_session_id, st.lease_expires_at,
         EXISTS (
           SELECT 1 FROM github_review_sessions newer
           WHERE newer.repo_id = grs.repo_id AND newer.pr_number = grs.pr_number
             AND newer.generation > grs.generation AND newer.head_sha = grs.head_sha
         ) AS head_reclaimed
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.session_id = ?`
    )
    .bind(sessionId)
    .first<CloseOutRow>();
}

async function deleteFenceRow(db: SqlDatabase, sessionId: string): Promise<void> {
  await db.prepare(`DELETE FROM github_review_sessions WHERE session_id = ?`).bind(sessionId).run();
}

/**
 * POST /internal/github-reviews/close-out
 * Called by the github-bot when a review session's turn has ended, however it
 * ended — its completion callback, a failed prompt delivery, or a reaper
 * drive — to obtain the right to terminalize that review's pending status.
 *
 * `request` records the close-out durably before any lease decision (the
 * first request's details win). Once recorded, the review's agent can never
 * take the lease again, and the row is kept until finalize reports a terminal
 * status. The grant is the PR's submission lease, held as
 * `close-out:<sessionId>`, and is given only while the session's row is the
 * newest registered for its head, a stale session is confirmed cancelled,
 * and no other holder's lease is live.
 *
 * 200 `granted`: the caller holds the lease for `leaseExpiresInMs` and may
 * replace a status it reads as pending, then must call finalize.
 * 202 `deferred`: another holder's lease is live or the stale session is not
 * yet cancelled; the request is recorded and the reaper re-drives it.
 * 409 `not_owned`: no close-out is owed — the row is gone, a newer review on
 * the same head owns the status, or no close-out was ever requested.
 */
export async function handleCloseOutReview(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, closeOutBodySchema, "Invalid close-out request body");
  if (parsed instanceof Response) return parsed;
  const { sessionId } = parsed;
  const meta = {
    session_id: sessionId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };
  const notOwned = (reason: string) => {
    logger.info("review_close_out.not_owned", {
      event: "review_close_out.not_owned",
      ...meta,
      reason,
    });
    return json({ outcome: "not_owned" }, 409);
  };
  const deferred = (reason: string) => {
    logger.info("review_close_out.deferred", {
      event: "review_close_out.deferred",
      ...meta,
      reason,
    });
    return json({ outcome: "deferred" }, 202);
  };

  if (parsed.request) await recordCloseOutRequest(ctx.db, sessionId, parsed.request);

  const row = await loadCloseOutRow(ctx.db, sessionId);
  if (!row) return notOwned("no_fence_row");
  if (row.head_reclaimed === 1) {
    await deleteFenceRow(ctx.db, sessionId);
    return notOwned("head_reclaimed");
  }
  if (row.close_out_request === null) return notOwned("not_requested");
  const closeOut = closeOutRequestSchema.safeParse(JSON.parse(row.close_out_request));
  if (!closeOut.success) return error("Invalid stored close-out request", 500);

  if (row.generation < row.latest_generation) {
    let outcome: StaleReviewCancellationOutcome;
    try {
      outcome = await cancelStaleReviewSession(ctx, new SessionIndexStore(ctx.db), row);
    } catch (cancelError) {
      logger.warn("review_close_out.cancel_threw", {
        event: "review_close_out.cancel_threw",
        ...meta,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
      outcome = "failed";
    }
    if (outcome === "orphaned") {
      await deleteFenceRow(ctx.db, sessionId);
      return notOwned("orphaned");
    }
    if (outcome !== "cancelled") return deferred(`stale_session_${outcome}`);
  }

  const now = Date.now();
  const acquired = await ctx.db
    .prepare(
      `UPDATE github_review_state SET lease_session_id = ?, lease_expires_at = ?
       WHERE repo_id = ? AND pr_number = ?
         AND (lease_session_id IS NULL OR lease_expires_at < ?)
         AND EXISTS (
           SELECT 1 FROM github_review_sessions grs
           WHERE grs.session_id = ?
             AND grs.repo_id = github_review_state.repo_id
             AND grs.pr_number = github_review_state.pr_number
             AND grs.close_out_request IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM github_review_sessions newer
               WHERE newer.repo_id = grs.repo_id AND newer.pr_number = grs.pr_number
                 AND newer.generation > grs.generation AND newer.head_sha = grs.head_sha
             )
         )
       RETURNING latest_generation`
    )
    .bind(
      closeOutHolder(sessionId),
      now + REVIEW_SUBMISSION_LEASE_MS,
      row.repo_id,
      row.pr_number,
      now,
      sessionId
    )
    .first<{ latest_generation: number }>();

  if (!acquired) {
    const current = await loadCloseOutRow(ctx.db, sessionId);
    if (!current) return notOwned("no_fence_row");
    if (current.head_reclaimed === 1) {
      await deleteFenceRow(ctx.db, sessionId);
      return notOwned("head_reclaimed");
    }
    return deferred("lease_busy");
  }

  const superseded = row.generation < acquired.latest_generation;
  logger.info("review_close_out.granted", {
    event: "review_close_out.granted",
    ...meta,
    superseded,
  });
  return json({
    outcome: "granted",
    owner: closeOut.data.owner,
    repo: closeOut.data.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    description: closeOut.data.description,
    superseded,
    leaseExpiresInMs: REVIEW_SUBMISSION_LEASE_MS,
  });
}

/**
 * POST /internal/github-reviews/close-out/finalize
 * Ends a granted close-out. `done` (GitHub shows a terminal status, written
 * or observed) deletes the fence row and releases the lease; `retry` only
 * releases the lease, keeping the row and its request for the reaper. Only a
 * lease still held as this close-out is touched. Always 204.
 */
export async function handleFinalizeCloseOut(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(
    request,
    closeOutFinalizeBodySchema,
    "Invalid close-out finalize body"
  );
  if (parsed instanceof Response) return parsed;
  const { sessionId, outcome } = parsed;
  const holder = closeOutHolder(sessionId);

  if (outcome === "done") {
    await ctx.db.batch([
      ctx.db.prepare(`DELETE FROM github_review_sessions WHERE session_id = ?`).bind(sessionId),
      ctx.db
        .prepare(
          `UPDATE github_review_state SET lease_session_id = NULL, lease_expires_at = NULL
           WHERE lease_session_id = ?`
        )
        .bind(holder),
    ]);
  } else {
    await ctx.db
      .prepare(`UPDATE github_review_state SET lease_expires_at = ? WHERE lease_session_id = ?`)
      .bind(Date.now() - 1, holder)
      .run();
  }
  logger.info("review_close_out.finalized", {
    event: "review_close_out.finalized",
    session_id: sessionId,
    outcome,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return new Response(null, { status: 204 });
}

/**
 * POST /sessions/:id/review-ownership
 * Sandbox-token-authenticated lease acquisition: the review agent calls this
 * immediately before its final GitHub writes. The lease is granted only
 * while the calling session is still the latest claimed generation for its
 * PR and its turn has not been closed out. This is the submission-boundary
 * fence that cancellation alone cannot provide: a same-head successor passes
 * the prompt's head-SHA check, but never this one.
 *
 * 204: acquired (re-acquiring one's own lease is an idempotent retry).
 * 423 + Retry-After: this session is eligible, but another holder's lease is
 * live — wait. 409: permanent — superseded, swept, or closed out; the agent
 * must exit without writing.
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
           AND grs.close_out_request IS NULL
       )
       AND (lease_session_id IS NULL OR lease_session_id = ? OR lease_expires_at < ?)`
    )
    .bind(sessionId, now + REVIEW_SUBMISSION_LEASE_MS, sessionId, sessionId, now)
    .run();
  if ((result.meta?.changes ?? 0) > 0) {
    return new Response(null, { status: 204 });
  }

  // The lease may be released between the UPDATE and this read; that costs
  // one spurious 423 and a retry, never a wrong 409.
  const eligible = await ctx.db
    .prepare(
      `SELECT st.lease_expires_at
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.session_id = ?
         AND grs.generation = st.latest_generation
         AND grs.close_out_request IS NULL`
    )
    .bind(sessionId)
    .first<{ lease_expires_at: number | null }>();
  if (!eligible) return error("Review generation superseded", 409);

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((eligible.lease_expires_at ?? now) - Date.now()) / 1000)
  );
  return new Response(JSON.stringify({ error: "Review submission lease busy" }), {
    status: 423,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
  });
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
 * Cron-driven reaper: the durable retry owner for review fence rows, so no
 * retained row depends on another PR event ever arriving. Each pass:
 *
 * 1. Drops rows older than REVIEW_FENCE_MAX_AGE_MS.
 * 2. Retries the cancellation of superseded sessions that owe no close-out
 *    (cancel unconfirmed, fresh-404 grace, or a creator's failed
 *    self-cancel), deleting each once cancelled — the sweep's rule.
 * 3. Re-drives every owed close-out whose PR has no live lease, by asking
 *    the github-bot to run it (a signed POST, as a background task).
 *    Duplicate drives are harmless: a second request finds the first one's
 *    lease live and is deferred.
 */
export async function reapSupersededReviewSessions(
  db: SqlDatabase,
  sessionRuntime: SessionRuntimeClient,
  env: Pick<Env, "GITHUB_BOT" | "SERVICE_AUTH_SECRET_GITHUB_BOT">,
  backgroundTasks: BackgroundTasks
): Promise<void> {
  const now = Date.now();
  const expired = await db
    .prepare(`DELETE FROM github_review_sessions WHERE created_at < ? RETURNING session_id`)
    .bind(now - REVIEW_FENCE_MAX_AGE_MS)
    .all<{ session_id: string }>();
  for (const row of expired.results) {
    logger.warn("review_reaper.expired", {
      event: "review_reaper.expired",
      session_id: row.session_id,
    });
  }

  const stale = await db
    .prepare(
      `SELECT grs.session_id, grs.created_at, st.lease_session_id, st.lease_expires_at
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.generation < st.latest_generation AND grs.close_out_request IS NULL
       ORDER BY grs.created_at ASC, grs.session_id ASC
       LIMIT ?`
    )
    .bind(REAPER_STALE_BATCH)
    .all<StaleReviewSessionRow>();
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
    if (outcome !== "cancelled" && outcome !== "orphaned") continue;
    await deleteFenceRow(db, row.session_id);
    logger.info("review_reaper.reaped", {
      event: "review_reaper.reaped",
      session_id: row.session_id,
    });
  }

  const owed = await db
    .prepare(
      `SELECT grs.session_id
       FROM github_review_sessions grs
       JOIN github_review_state st
         ON st.repo_id = grs.repo_id AND st.pr_number = grs.pr_number
       WHERE grs.close_out_request IS NOT NULL
         AND (st.lease_expires_at IS NULL OR st.lease_expires_at < ?)
       ORDER BY grs.created_at ASC, grs.session_id ASC
       LIMIT ?`
    )
    .bind(now, REAPER_CLOSE_OUT_BATCH)
    .all<{ session_id: string }>();
  if (owed.results.length === 0) return;
  const githubBot = env.GITHUB_BOT;
  const secret = callbackSigningSecret(env, "github-bot");
  if (!githubBot || !secret) {
    logger.warn("review_reaper.close_out_undeliverable", {
      event: "review_reaper.close_out_undeliverable",
      session_ids: owed.results.map((row) => row.session_id),
      reason: githubBot ? "missing_signing_secret" : "missing_github_bot_binding",
    });
    return;
  }
  for (const { session_id: sessionId } of owed.results) {
    backgroundTasks.submit(
      async () => {
        const payload = { sessionId, timestamp: Date.now() };
        const signature = await computeHmacHex(JSON.stringify(payload), secret);
        const response = await githubBot.fetch("https://internal/callbacks/review-close-out", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, signature }),
          signal: AbortSignal.timeout(CLOSE_OUT_DRIVE_TIMEOUT_MS),
        });
        logger.info("review_reaper.close_out_driven", {
          event: "review_reaper.close_out_driven",
          session_id: sessionId,
          status: response.status,
        });
      },
      { name: "review_close_out_drive", context: { session_id: sessionId } }
    );
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

githubReviewRoutes.post(
  "/internal/github-reviews/close-out",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatchSession(c, handleCloseOutReview)
);

githubReviewRoutes.post(
  "/internal/github-reviews/close-out/finalize",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatch(c, handleFinalizeCloseOut)
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
