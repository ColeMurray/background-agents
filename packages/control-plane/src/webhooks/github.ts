/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot, proxies them to
 * the SchedulerDO for automation matching, and piggybacks PR lifecycle
 * tracking (design §5.2) on the same forward. The lifecycle step runs in the
 * background and is additive: its failure never affects automation matching.
 */

import { automationEventSchema } from "@open-inspect/shared";
import { SessionIndexStore } from "../db/session-index";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { createLogger, parseLogLevel } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import type { RequestContext, Route } from "../routes/shared";
import { error, parsePattern } from "../routes/shared";
import {
  authenticateAutomationEvent,
  forwardAutomationEventToScheduler,
  validateAutomationEventEnvelope,
} from "./automation-event";
import {
  processPullRequestLifecycleEvent,
  type PullRequestLifecycleDeps,
  type SessionArtifactSummary,
} from "./pull-request-lifecycle";

function validateGitHubEvent(event: Record<string, unknown>): string | null {
  return !event.repoOwner || !event.repoName
    ? "Invalid event: repoOwner and repoName are required"
    : null;
}

/**
 * Best-effort PR lifecycle tracking for one normalized event. Runs in
 * waitUntil off the request path; every failure is logged and swallowed.
 */
async function trackPullRequestLifecycle(
  env: Env,
  rawEvent: Record<string, unknown>,
  ctx: RequestContext
): Promise<void> {
  const log = createLogger(
    "webhook:pr-lifecycle",
    { trace_id: ctx.trace_id, request_id: ctx.request_id },
    parseLogLevel(env.LOG_LEVEL)
  );
  try {
    if (!env.DB || !env.SESSION) return;

    const parsed = automationEventSchema.safeParse(rawEvent);
    if (!parsed.success || parsed.data.source !== "github" || !parsed.data.pullRequest) return;
    const event = parsed.data;

    const sessionRuntime = createSessionRuntimeClient(env, ctx);
    const deps: PullRequestLifecycleDeps = {
      store: new SessionPullRequestStore(env.DB),
      sessions: new SessionIndexStore(env.DB),
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
      log,
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
  const authFailure = await authenticateAutomationEvent(request, env);
  if (authFailure) return authFailure;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON", 400);
  }

  const validated = validateAutomationEventEnvelope(body, "github", validateGitHubEvent);
  if (validated.response) return validated.response;

  const lifecycleWork = trackPullRequestLifecycle(env, validated.event, ctx);
  if (ctx.executionCtx) {
    ctx.executionCtx.waitUntil(lifecycleWork);
  } else {
    await lifecycleWork;
  }

  return forwardAutomationEventToScheduler(env, validated.event);
}

export const githubAutomationEventRoute: Route = {
  method: "POST",
  pattern: parsePattern("/internal/github-event"),
  handler: handleGitHubAutomationEvent,
};
