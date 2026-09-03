import type { Logger } from "../logger";
import type { SessionUpgradeAdmission } from "../session/connection-authenticator";

/**
 * Complete a WebSocket upgrade the way Workers do it: the session decides,
 * then the server half of a `WebSocketPair` is attached to the runtime and
 * the client half rides back on a 101 response. `log` is the session logger;
 * the decision carries its own request-scoped one.
 */
export async function upgradeWebSocket(
  upgrades: SessionUpgradeAdmission,
  request: Request,
  log: Logger
): Promise<Response> {
  const decision = await upgrades.authorize(request);
  if (decision.kind === "reject") return decision.response;

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  try {
    await decision.attach(server);
  } catch (error) {
    log.error("WebSocket upgrade failed", {
      ws_type: decision.role,
      error: error instanceof Error ? error : String(error),
    });
    // Attachment commits nothing before its one await, so the server half is
    // either unaccepted or fully attached; closing covers both without
    // leaving the runtime a socket the client never received.
    try {
      server.close(1011, "WebSocket upgrade failed");
    } catch {
      // Never accepted: there is nothing to close.
    }
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  return new Response(null, { status: 101, webSocket: client });
}
