/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleControlPlaneHttp } from "./cloudflare/http-host";
import { createLogger } from "./logger";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { handleAutofixQueue } from "./autofix/handler";
import { consumeImageBuildFinalizations } from "./image-builds/finalization-consumer";
import { createSessionRuntimeClient } from "./session/runtime-client";
import {
  createRequestMetrics,
  instrumentSqlDatabase,
  type RequestMetrics,
} from "./db/instrumented-sql-database";
import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import { createCloudflareBackgroundTasks } from "./cloudflare/background-tasks";
import { createCloudflareEnv, type WorkerBindings } from "./cloudflare/platform";
import { findScheduledJob } from "./scheduled-jobs";
import { isAutofixQueue } from "./queue-routing";

const logger = createLogger("worker");

// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./cloudflare/durable-object";

export default {
  async fetch(
    request: Request,
    bindings: WorkerBindings,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for session
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      const metrics = createRequestMetrics();
      // eslint-disable-next-line no-restricted-syntax -- composition root: construct the request-scoped database adapter
      const db = instrumentSqlDatabase(bindings.DB, metrics);
      return handleWebSocket(request, bindings, url, db, metrics);
    }

    // Regular API request — Hono owns HTTP route selection while the neutral
    // admission/dispatch pipeline retains authentication and authorization.
    return handleControlPlaneHttp(request, createCloudflareEnv(bindings), ctx);
  },

  /**
   * Cron trigger handler: runs the job bound to the trigger's expression.
   */
  async scheduled(
    event: ScheduledEvent,
    bindings: WorkerBindings,
    ctx: ExecutionContext
  ): Promise<void> {
    const job = findScheduledJob(event.cron);
    if (!job) {
      logger.warn("Unknown scheduled trigger", { cron: event.cron });
      return;
    }
    const env = createCloudflareEnv(bindings);
    const runId = crypto.randomUUID();
    const correlation = { trace_id: runId, request_id: runId };
    await job.run(
      {
        env,
        // eslint-disable-next-line no-restricted-syntax -- scheduled composition root: the one cron env.DB read
        db: env.DB,
        sessions: createSessionRuntimeClient(env, correlation),
        backgroundTasks: createCloudflareBackgroundTasks(ctx),
        log: logger,
        correlation,
      },
      Date.now()
    );
  },

  async queue(batch: MessageBatch<unknown>, bindings: WorkerBindings): Promise<void> {
    const env = createCloudflareEnv(bindings);
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
  env: WorkerBindings,
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
