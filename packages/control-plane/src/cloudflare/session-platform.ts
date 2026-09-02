import type { SqlDatabase } from "../db/sql-database";
import type { SessionPlatform } from "../session/platform";
import { createCloudflareBackgroundTasks } from "./background-tasks";

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
      accept: (ws, tags) => ctx.acceptWebSocket(ws, tags),
      tags: (ws) => ctx.getTags(ws),
      sockets: (tag) => ctx.getWebSockets(tag),
      // Hibernation-level auto-response: matched by the runtime without
      // waking the object.
      setAutoResponse: (request, response) =>
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(request, response)),
    },
    createBackgroundTasks: (log) => createCloudflareBackgroundTasks(ctx, log),
  };
}
