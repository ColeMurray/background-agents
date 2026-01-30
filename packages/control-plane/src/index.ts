/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleRequest } from "./router";
import { createLogger, parseLogLevel } from "./logger";
import type { Logger } from "./logger";
import type { Env } from "./types";

// Re-export Durable Object for Cloudflare to discover
export { SessionDO } from "./session/durable-object";

/**
 * Worker fetch handler.
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const log = createLogger("worker", {}, parseLogLevel(env.LOG_LEVEL));

    // WebSocket upgrade for session
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return handleWebSocket(request, env, url, log);
    }

    // Regular API request
    log.info("Request received", {
      method: request.method,
      path: url.pathname,
    });
    return handleRequest(request, env);
  },
};

/**
 * Handle WebSocket connections.
 */
async function handleWebSocket(
  request: Request,
  env: Env,
  url: URL,
  log: Logger
): Promise<Response> {
  log.info("WebSocket upgrade", { path: url.pathname });

  // Extract session ID from path: /sessions/:id/ws
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);

  if (!match) {
    log.warn("Invalid WebSocket path", { path: url.pathname });
    return new Response("Invalid WebSocket path", { status: 400 });
  }

  const sessionId = match[1];
  log.info("WebSocket upgrade", { sessionId });

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
