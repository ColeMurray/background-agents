/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleRequest } from "./router";
import { createLogger } from "./logger";
import type { Env } from "./types";

const logger = createLogger("worker");

// Re-export Durable Object for Cloudflare to discover
export { SessionDO } from "./session/durable-object";

/**
 * Worker fetch handler.
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for session
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return handleWebSocket(request, env, url);
    }

    // Regular API request — logged by the router with requestId and timing
    return handleRequest(request, env);
  },
};

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
