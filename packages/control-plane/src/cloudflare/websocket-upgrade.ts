import type { Logger } from "../logger";
import type { SessionUpgradeAdmission } from "../session/connection-authenticator";

/**
 * Complete a WebSocket upgrade the way Workers do it: the session decides,
 * then the server half of a `WebSocketPair` is attached to the runtime and
 * the client half rides back on a 101 response.
 */
export async function upgradeWebSocket(
  upgrades: SessionUpgradeAdmission,
  request: Request,
  log: Logger
): Promise<Response> {
  const decision = await upgrades.authorize(request, log);
  if (decision.kind === "reject") return decision.response;

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  try {
    await upgrades.attach(server, decision, log);
  } catch (error) {
    log.error("WebSocket upgrade failed", {
      error: error instanceof Error ? error : String(error),
    });
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  return new Response(null, { status: 101, webSocket: client });
}
