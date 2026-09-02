/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot, proxies them to
 * the scheduler for automation matching, and piggybacks PR lifecycle
 * tracking (design §5.2) on the same forward. The lifecycle step runs in the
 * background and is additive: its failure never affects automation matching.
 */

import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import { SessionIndexStore } from "../db/session-index";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { createLogger, parseLogLevel } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import type { RequestContext, Route } from "../routes/shared";
import { defineRoute, error, GITHUB_SERVICE_ROUTE, serviceAuthorized } from "../routes/shared";
import {
  forwardAutomationEventToScheduler,
  logAutomationEventRejection,
  validateAutomationEventEnvelope,
} from "./automation-event";
import {
  processPullRequestLifecycleEvent,
  type PullRequestLifecycleDeps,
  type SessionArtifactSummary,
} from "./pull-request-lifecycle";

/**
 * Best-effort PR lifecycle tracking for one normalized event. Runs in
 * waitUntil off the request path; every failure is logged and swallowed.
 */
async function trackPullRequestLifecycle(
  env: Env,
  event: GitHubAutomationEvent,
  ctx: RequestContext
): Promise<void> {
  const log = createLogger(
    "webhook:pr-lifecycle",
    { trace_id: ctx.trace_id, request_id: ctx.request_id },
    parseLogLevel(env.LOG_LEVEL)
  );
  try {
    if (!env.SESSION) return;

    if (!event.pullRequest) return;

    const sessionRuntime = createSessionRuntimeClient(env, ctx);
    const deps: PullRequestLifecycleDeps = {
      store: new SessionPullRequestStore(ctx.db),
      sessions: new SessionIndexStore(ctx.db),
      listSessionArtifacts: async (sessionId): Promise<SessionArtifactSummary[]> => {
        const response = await sessionRuntime.fetch(sessionId, SessionInternalPaths.artifacts, {
          method: "GET",
        });
        if (!response.ok) return [];
        const body = await response.json<{ artifacts?: SessionArtifactSummary[] }>();
        return body.artifacts ?? [];
      },
      pushSnapshotToSession: async (sessionId, artifactId, snapshot) => {
        const response = await sessionRuntime.fetch(
          sessionId,
          SessionInternalPaths.pullRequestArtifactSnapshot,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(snapshot),
          },
          `?artifactId=${encodeURIComponent(artifactId)}`
        );
        // fetch resolves on 4xx/5xx — a rejected push must fail loudly
        // instead of reading as a mirrored update. The D1 authority has
        // already advanced; read-through repairs the mirror.
        if (!response.ok) {
          throw new Error(`Snapshot push to session DO failed (status ${response.status})`);
        }
      },
      now: () => Date.now(),
    };

    const outcome = await processPullRequestLifecycleEvent(deps, event);
    log.info("pull_request_lifecycle.processed", {
      outcome,
      event_type: event.eventType,
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      pr_number: event.pullRequest?.number,
    });
  } catch (err) {
    log.error("pull_request_lifecycle.failed", {
      error: err instanceof Error ? err : String(err),
    });
  }
}

async function handleGitHubAutomationEvent(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logAutomationEventRejection(undefined, "github", ["body"], ctx);
    return error("Invalid JSON", 400);
  }

  const validated = validateAutomationEventEnvelope(body, "github");
  if (validated.response) {
    logAutomationEventRejection(body, "github", validated.issuePaths, ctx);
    return validated.response;
  }

  ctx.executionCtx.submit(() => trackPullRequestLifecycle(env, validated.event, ctx), {
    name: "github_webhook.lifecycle",
  });

  return forwardAutomationEventToScheduler(env, validated.event, ctx);
}

export const githubAutomationEventRoute: Route = defineRoute(GITHUB_SERVICE_ROUTE, {
  method: "POST",
  path: "/internal/github-event",
  authorization: serviceAuthorized("github-bot"),
  handler: handleGitHubAutomationEvent,
});
