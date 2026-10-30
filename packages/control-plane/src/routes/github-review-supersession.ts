import { Hono } from "hono";
import { z } from "zod";
import { GitHubPrReviewStore } from "../db/github-pr-review-store";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { parseBody } from "./body";
import { type SessionRouteContext, dispatchSession } from "./session-route";
import { error, GITHUB_SERVICE_ROUTE, json, serviceAuthorized } from "./shared";

const logger = createLogger("router:github-review-supersession");

/**
 * Bound on cancelling the review a newer one replaced. The new review is
 * already recorded, so a stalled session must not hold the webhook open.
 */
const REVIEW_SUPERSESSION_CANCEL_TIMEOUT_MS = 10_000;

const requestSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pullNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** 404 and 409 mean the session is already gone or no longer running. */
async function cancelDisplacedSession(
  ctx: SessionRouteContext,
  sessionId: string
): Promise<boolean> {
  try {
    const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.cancel, {
      method: "POST",
      signal: AbortSignal.timeout(REVIEW_SUPERSESSION_CANCEL_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok || response.status === 404 || response.status === 409) return true;
    logger.warn("review_supersession.cancel_failed", {
      session_id: sessionId,
      status: response.status,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    return false;
  } catch (cause) {
    logger.warn("review_supersession.cancel_failed", {
      session_id: sessionId,
      error: cause instanceof Error ? cause : new Error(String(cause)),
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    return false;
  }
}

export async function handleGitHubReviewSupersession(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const principal = ctx.principal;
  if (
    principal?.kind !== "service" ||
    principal.service !== "github-bot" ||
    principal.actor !== null
  ) {
    return error("Actorless github-bot authentication required", 403);
  }

  const body = await parseBody(request, requestSchema, "Invalid review supersession request");
  if (body instanceof Response) return body;

  const store = new GitHubPrReviewStore(ctx.db);
  const displacedSessionIds = await store.claim({
    sessionId: body.sessionId,
    repositoryId: body.repositoryId,
    pullNumber: body.pullNumber,
    updatedAt: Date.now(),
  });

  for (const displacedSessionId of displacedSessionIds) {
    if (await cancelDisplacedSession(ctx, displacedSessionId)) continue;
    // The displaced prompt may already be queued or running. Leaving it
    // marked superseded would hide it from the next claim and would not
    // stop that work, so give the review back and refuse this one.
    const restored = await store.restoreAfterFailedCancel({
      claimantSessionId: body.sessionId,
      displacedSessionId,
      updatedAt: Date.now(),
    });
    logger.warn("review_supersession.cancel_not_superseded", {
      session_id: body.sessionId,
      displaced_session_id: displacedSessionId,
      restored,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    return error("Could not cancel the in-flight review", 503);
  }

  logger.info("review_supersession.claimed", {
    session_id: body.sessionId,
    repository_id: body.repositoryId,
    pull_number: body.pullNumber,
    displaced_count: displacedSessionIds.length,
    trace_id: ctx.trace_id,
    request_id: ctx.request_id,
  });

  return json({ displacedSessionIds });
}

export const githubReviewSupersessionRoutes = new Hono<ControlPlaneHonoEnv>();

githubReviewSupersessionRoutes.post(
  "/internal/github-reviews/supersede",
  admit({
    ...GITHUB_SERVICE_ROUTE,
    authorization: serviceAuthorized("github-bot"),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, handleGitHubReviewSupersession)
);
