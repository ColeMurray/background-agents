/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleRequest } from "./router";
import { createLogger } from "./logger";
import { ImageBuildStore } from "./db/image-builds";
import {
  DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS,
  DEFAULT_STALE_BUILD_MAX_AGE_MS,
} from "./image-builds/maintenance";
import { createImageBuildWorkflowFromEnv } from "./image-builds/workflow";
import type { Env } from "./types";

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
      return handleWebSocket(request, env, url);
    }

    // Regular API request — logged by the router with requestId and timing
    return handleRequest(request, env, ctx);
  },

  /** Run image-build maintenance and wake the SchedulerDO for overdue automations. */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runImageBuildMaintenance(env);

    if (!env.SCHEDULER) {
      logger.debug("SCHEDULER binding not configured, skipping scheduled automation tick");
      return;
    }

    // Always wake the SchedulerDO — it runs both the recovery sweep
    // (orphaned/timed-out runs) and processes overdue automations.
    const doId = env.SCHEDULER.idFromName("global-scheduler");
    const stub = env.SCHEDULER.get(doId);

    await stub.fetch("http://internal/internal/tick", { method: "POST" });
  },
};

export async function runImageBuildMaintenance(env: Env): Promise<void> {
  const context = {
    trace_id: crypto.randomUUID(),
    request_id: crypto.randomUUID().slice(0, 8),
  };

  try {
    const markedFailed = await new ImageBuildStore(env.DB).markStaleBuildsAsFailed(
      DEFAULT_STALE_BUILD_MAX_AGE_MS
    );
    if (markedFailed > 0) {
      logger.info("image_build.stale_marked", { count: markedFailed, ...context });
    }
  } catch (errorValue) {
    logger.warn("image_build.mark_stale_error", {
      error: errorValue instanceof Error ? errorValue.message : String(errorValue),
      ...context,
    });
  }

  try {
    const result = await createImageBuildWorkflowFromEnv(env).cleanupImages(
      DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS,
      context
    );
    if (result.deletedFailed || result.reapedFailed || result.reapedSuperseded) {
      logger.info("image_build.cleanup", {
        deleted_failed: result.deletedFailed,
        reaped_failed: result.reapedFailed,
        reaped_superseded: result.reapedSuperseded,
        ...context,
      });
    }
  } catch (errorValue) {
    logger.warn("image_build.cleanup_error", {
      error: errorValue instanceof Error ? errorValue.message : String(errorValue),
      ...context,
    });
  }
}

/**
 * Handle WebSocket connections.
 */
async function handleWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  // Extract session ID from path: /sessions/:id/ws
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);

  if (!match) {
    logger.warn("Invalid WebSocket path", { event: "ws.invalid_path", http_path: url.pathname });
    return new Response("Invalid WebSocket path", { status: 400 });
  }

  const sessionId = match[1];
  logger.info("WebSocket upgrade", {
    event: "ws.connect",
    http_path: url.pathname,
    session_id: sessionId,
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
