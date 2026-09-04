import type { SqlDatabase } from "../db/sql-database";
import type { SessionWebSocket } from "../platform-ports";
import type { SessionPlatform } from "../session/platform";
import { createCloudflareBackgroundTasks } from "./background-tasks";

/**
 * The core types its sockets structurally; only this object's own
 * hibernatable sockets ever reach its host, so anything else is a wiring
 * error rather than a socket to adopt.
 */
function requireCloudflareWebSocket(ws: SessionWebSocket): WebSocket {
  if (!(ws instanceof WebSocket)) {
    throw new TypeError("Durable Object socket host received a socket it did not upgrade");
  }
  return ws;
}

/**
 * A Durable Object's storage, hibernatable sockets, alarm, and event lifetime
 * as the session platform, over the deployment's global store.
 */
export function createDurableObjectSessionPlatform(
  ctx: DurableObjectState,
  db: SqlDatabase
): SessionPlatform {
  return {
    id: ctx.id.toString(),
    storage: ctx.storage,
    db,
    alarmStore: ctx.storage,
    sockets: {
      adopt: (ws, tags) => ctx.acceptWebSocket(requireCloudflareWebSocket(ws), tags),
      tags: (ws) => ctx.getTags(requireCloudflareWebSocket(ws)),
      sockets: (tag) => ctx.getWebSockets(tag),
      // Hibernation-level auto-response: matched by the runtime without
      // waking the object.
      setAutoResponse: (request, response) =>
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(request, response)),
    },
    createBackgroundTasks: (log) => createCloudflareBackgroundTasks(ctx, log),
  };
}
