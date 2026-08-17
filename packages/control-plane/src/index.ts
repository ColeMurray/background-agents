/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleRequest } from "./router";
import { createLogger } from "./logger";
import type { Env } from "./types";
import { consumeImageBuildFinalizations } from "./image-builds/finalization-consumer";
import { IMAGE_BUILD_SCHEDULER_CRON, runImageBuildScheduler } from "./image-builds/scheduler";
import {
  ABANDONED_DRAFT_SWEEP_CRON,
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import { createRequestMetrics, instrumentD1, type RequestMetrics } from "./db/instrumented-d1";
import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import { createCloudflareBackgroundTasks } from "./cloudflare/background-tasks";
import { reapSupersededReviewSessions } from "./routes/github-reviews";
import { createSessionRuntimeClient } from "./session/runtime-client";

const logger = createLogger("worker");

// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./session/durable-object";
export { SchedulerDO } from "./scheduler/durable-object";

/**
 * Worker fetch handler.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for session
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      const metrics = createRequestMetrics();
      // eslint-disable-next-line no-restricted-syntax -- composition root: construct the request-scoped database adapter
      const db = instrumentD1(env.DB, metrics);
      return handleWebSocket(request, env, url, db, metrics);
    }

    // Regular API request — logged by the router with requestId and timing
    return handleRequest(request, env, createCloudflareBackgroundTasks(ctx));
  },

  /**
   * Cron trigger handler — wakes the SchedulerDO to process overdue automations.
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === IMAGE_BUILD_SCHEDULER_CRON) {
      const requestId = crypto.randomUUID();
      // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: the one cron env.DB read
      await runImageBuildScheduler(env, env.DB, {
        request_id: requestId,
        trace_id: requestId,
      });
      return;
    }
    if (event.cron === ABANDONED_DRAFT_SWEEP_CRON) {
      await new AbandonedDraftSweep(
        // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: the one cron env.DB read
        new SessionIndexStore(env.DB),
        new SessionDraftExpiryClient(env.SESSION),
        logger
      ).run(Date.now());
      return;
    }
    if (event.cron !== "* * * * *") {
      logger.warn("Unknown scheduled trigger", { cron: event.cron });
      return;
    }
    const requestId = crypto.randomUUID();
    const cronCtx = {
      request_id: requestId,
      trace_id: requestId,
      metrics: createRequestMetrics(),
    };
    // Always wake the SchedulerDO first — it runs both the recovery sweep
    // (orphaned/timed-out runs) and processes overdue automations, and must
    // not be delayed or skipped by a slow or failing review reaper.
    if (env.SCHEDULER) {
      const doId = env.SCHEDULER.idFromName("global-scheduler");
      const stub = env.SCHEDULER.get(doId);
      try {
        await stub.fetch("http://internal/internal/tick", { method: "POST" });
      } catch (tickError) {
        logger.warn("Scheduler tick failed", {
          event: "scheduler.tick_failed",
          error: tickError instanceof Error ? tickError.message : String(tickError),
        });
      }
    } else {
      logger.debug("SCHEDULER binding not configured, skipping scheduler tick");
    }

    try {
      // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: cron env.DB read
      const db = instrumentD1(env.DB, cronCtx.metrics);
      await reapSupersededReviewSessions(db, createSessionRuntimeClient(env, cronCtx));
    } catch (reaperError) {
      logger.warn("Review reaper tick failed", {
        event: "review_reaper.tick_failed",
        error: reaperError instanceof Error ? reaperError.message : String(reaperError),
      });
    }
    logger.info("review_reaper.tick", {
      event: "review_reaper.tick",
      ...cronCtx.metrics.summarize(),
    });
  },

  queue: consumeImageBuildFinalizations,
};

/**
 * Handle WebSocket connections.
 */
async function handleWebSocket(
  request: Request,
  env: Env,
  url: URL,
  db: SqlDatabase,
  metrics: RequestMetrics
): Promise<Response> {
  // Extract session ID from path: /sessions/:id/ws
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);

  if (!match) {
    logger.warn("Invalid WebSocket path", { event: "ws.invalid_path", http_path: url.pathname });
    return new Response("Invalid WebSocket path", { status: 400 });
  }

  const sessionId = match[1];
  if (!(await new SessionIndexStore(db).exists(sessionId))) {
    logger.warn("WebSocket session not found", {
      event: "ws.session_not_found",
      http_path: url.pathname,
      session_id: sessionId,
      ...metrics.summarize(),
    });
    return new Response("Session not found", { status: 404 });
  }

  logger.info("WebSocket upgrade", {
    event: "ws.connect",
    http_path: url.pathname,
    session_id: sessionId,
    ...metrics.summarize(),
  });

  // Get Durable Object and forward WebSocket
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  // Forward the WebSocket upgrade request to the DO
  const response = await stub.fetch(request);

  // If it's a WebSocket upgrade response, return it directly
  // Add CORS headers for the upgrade response
  if (response.webSocket) {
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return response;
}
