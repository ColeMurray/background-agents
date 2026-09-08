/**
 * The Node host's WebSocket upgrade path for `/sessions/:id/ws`, doing on
 * one process what the Worker and the Durable Object do between them: the
 * session must exist in the index (404 otherwise; any other upgrade path
 * is 400), the session decides the upgrade, and the host completes the
 * handshake and hands the runtime its socket.
 *
 * The decision is made under the runtime's lease, so the runtime is there
 * to attach to, and the socket is paused from the moment the handshake
 * completes until the runtime has adopted it: the peer may send as soon as
 * it sees the 101, and a frame that arrived before adoption would have no
 * listener. A rejection carries the session's response; it is written to
 * the raw socket as the status line the peer's client library reports.
 *
 * The handler is total: every outcome answers the socket or destroys it,
 * and nothing it awaits can reject past it. The HTTP server's boundary
 * catches whatever might still escape.
 */

import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import { createRequestMetrics, instrumentSqlDatabase } from "../db/instrumented-sql-database";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionUpgradeAdmission } from "../session/connection-authenticator";
import type { SessionRuntimeLookup } from "./runtime-client";

/**
 * The largest frame a peer may send, the Workers runtime's WebSocket
 * message limit, so a bridge or browser sees the same bound on both hosts.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const SESSION_WS_PATH = /^\/sessions\/([^/]+)\/ws$/;

/** What the upgrade needs of a runtime: the decision, and a logger for its failures. */
export interface UpgradeServingRuntime {
  readonly upgrades: SessionUpgradeAdmission;
  readonly log: Logger;
}

export interface SessionUpgradeHandlerOptions<Runtime extends UpgradeServingRuntime> {
  /** The global store; the session index is read through it, instrumented as the Worker does. */
  db: SqlDatabase;
  runtimes: SessionRuntimeLookup<Runtime>;
  log: Logger;
  /** The handshake server; one without its own listener is created otherwise. */
  webSocketServer?: WebSocketServer;
}

/** The `upgrade` listener of a Node HTTP server. */
export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => Promise<void>;

export function createSessionUpgradeHandler<Runtime extends UpgradeServingRuntime>(
  options: SessionUpgradeHandlerOptions<Runtime>
): UpgradeHandler {
  const { db, runtimes, log } = options;
  const server =
    options.webSocketServer ??
    new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const serve = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      log.warn("Invalid WebSocket request", {
        event: "ws.invalid_request",
        http_path: request.url,
      });
      refuse(socket, 400, "Invalid WebSocket request");
      return;
    }
    const match = url.pathname.match(SESSION_WS_PATH);
    if (!match) {
      log.warn("Invalid WebSocket path", { event: "ws.invalid_path", http_path: url.pathname });
      refuse(socket, 400, "Invalid WebSocket path");
      return;
    }
    const sessionId = match[1];

    const metrics = createRequestMetrics();
    if (!(await new SessionIndexStore(instrumentSqlDatabase(db, metrics)).exists(sessionId))) {
      log.warn("WebSocket session not found", {
        event: "ws.session_not_found",
        http_path: url.pathname,
        session_id: sessionId,
        ...metrics.summarize(),
      });
      refuse(socket, 404, "Session not found");
      return;
    }
    log.info("WebSocket upgrade", {
      event: "ws.connect",
      http_path: url.pathname,
      session_id: sessionId,
      ...metrics.summarize(),
    });

    const upgradeRequest = toRequest(request, url);
    const rejection = await runtimes.withRuntimeIfPresent(sessionId, (runtime) =>
      admit(runtime, upgradeRequest, server, request, socket, head)
    );
    if (rejection === undefined) {
      // Indexed a moment ago, gone by the time the runtime was opened.
      refuse(socket, 404, "Session not found");
      return;
    }
    if (rejection !== null) refuse(socket, rejection.status, await rejection.text());
  };

  return async (request, socket, head) => {
    // The HTTP server hands the socket over with no error listener: a peer
    // that resets while the index is read must not take the process down.
    socket.on("error", (error: Error) => {
      log.debug("ws.socket_error", { event: "ws.socket_error", error_message: error.message });
    });
    try {
      await serve(request, socket, head);
    } catch (error) {
      log.error("WebSocket upgrade failed", {
        event: "ws.upgrade_failed",
        http_path: request.url,
        error: error instanceof Error ? error : String(error),
      });
      refuse(socket, 500, "WebSocket upgrade failed");
    }
  };
}

/**
 * Decide and, if accepted, complete the upgrade and attach the socket.
 * Resolves with the rejection to write, or `null` once the socket is the
 * runtime's or the handshake failed on the wire.
 */
async function admit(
  runtime: UpgradeServingRuntime,
  upgradeRequest: Request,
  server: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<Response | null> {
  const decision = await runtime.upgrades.authorize(upgradeRequest);
  if (decision.kind === "reject") return decision.response;

  const ws = await completeHandshake(server, request, socket, head);
  if (ws === null) {
    runtime.log.warn("WebSocket handshake aborted", {
      event: "ws.handshake_aborted",
      ws_type: decision.role,
    });
    return null;
  }
  try {
    await decision.attach(ws);
  } catch (error) {
    runtime.log.error("WebSocket upgrade failed", {
      ws_type: decision.role,
      error: error instanceof Error ? error : String(error),
    });
    // Attachment commits nothing before its one await, so the socket is
    // either unadopted or fully attached; closing covers both. Resumed
    // first so the peer's close frame is read and the close completes.
    ws.resume();
    ws.close(1011, "WebSocket upgrade failed");
    return null;
  }
  ws.resume();
  return null;
}

/**
 * The 101 and the socket, paused, or `null` when the handshake could not
 * complete: the peer had gone, or its handshake was malformed and `ws`
 * answered it. `ws` reports the latter only by closing the socket, so the
 * socket's close is the other way this settles.
 */
function completeHandshake(
  server: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<NodeWebSocket | null> {
  return new Promise((resolve) => {
    if (socket.destroyed || !socket.readable || !socket.writable) {
      socket.destroy();
      resolve(null);
      return;
    }
    const onClose = (): void => resolve(null);
    socket.once("close", onClose);
    server.handleUpgrade(request, socket, head, (ws) => {
      socket.off("close", onClose);
      ws.pause();
      resolve(ws);
    });
  });
}

/** The upgrade request as the session's authenticator reads it: the URL and the headers. */
function toRequest(request: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return new Request(url, { method: request.method ?? "GET", headers });
}

/** Answer the upgrade with a plain HTTP response and close the connection, as `ws` does. */
function refuse(socket: Duplex, status: number, body: string): void {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }
  const payload = Buffer.from(body, "utf8");
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${payload.length}\r\n` +
      "\r\n" +
      body
  );
}
