/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleControlPlaneHttp } from "./routing/hono-app";
import { createLogger } from "./logger";
import type { Env } from "./types";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { handleAutofixQueue } from "./autofix/handler";
import { checkAutofixQueueHealth } from "./autofix/queue-health";
import { consumeImageBuildFinalizations } from "./image-builds/finalization-consumer";
import { IMAGE_BUILD_SCHEDULER_CRON, runImageBuildScheduler } from "./image-builds/scheduler";
import {
  ABANDONED_DRAFT_SWEEP_CRON,
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import { createSessionRuntimeClient } from "./session/runtime-client";
import { createRequestMetrics, instrumentD1, type RequestMetrics } from "./db/instrumented-d1";
import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import { createCloudflareBackgroundTasks } from "./cloudflare/background-tasks";
import { Scheduler } from "./scheduler/scheduler";
import { isAutofixQueue } from "./queue-routing";

const logger = createLogger("worker");

// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./session/durable-object";

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

    // Regular API request — Hono owns HTTP route selection while the neutral
    // admission/dispatch pipeline retains authentication and authorization.
    return handleControlPlaneHttp(request, env, ctx);
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
      const sweepId = crypto.randomUUID();
      const sweepContext = { trace_id: sweepId, request_id: sweepId };
      await new AbandonedDraftSweep(
        // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: the one cron env.DB read
        new SessionIndexStore(env.DB),
        new SessionDraftExpiryClient(createSessionRuntimeClient(env, sweepContext)),
        logger
      ).run(Date.now());
      return;
    }
    if (event.cron !== "* * * * *") {
      logger.warn("Unknown scheduled trigger", { cron: event.cron });
      return;
    }
    ctx.waitUntil(checkAutofixQueueHealth(env, logger));
    // The tick runs both the recovery sweep (orphaned/timed-out runs) and
    // processes overdue automations.
    // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: construct the scheduler's database dependency
    await new Scheduler(env.DB, env, createCloudflareBackgroundTasks(ctx)).tick();
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (!isAutofixQueue(batch.queue)) {
      await consumeImageBuildFinalizations(batch, env);
      return;
    }
    // eslint-disable-next-line no-restricted-syntax -- worker composition root: inject D1 once
    await handleAutofixQueue(batch as MessageBatch<GitHubAutofixEnvelope>, env, env.DB);
  },
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

  // Forward the upgrade to the Durable Object directly rather than through
  // SessionRuntimeClient: the 101 must carry the object's own `webSocket`,
  // which only this Cloudflare-side hop can return. Stays here by design.
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
