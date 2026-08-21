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
import { Scheduler } from "./scheduler/scheduler";

const logger = createLogger("worker");

// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./session/durable-object";

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
   * Cron trigger handler — processes overdue automations.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
    // The tick runs both the recovery sweep (orphaned/timed-out runs) and
    // processes overdue automations.
    // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: construct the scheduler's database dependency
    await new Scheduler(env.DB, env, createCloudflareBackgroundTasks(ctx)).tick();
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
