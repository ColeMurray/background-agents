/**
 * NodeSocketHost — the session's `SocketHost` over `ws` sockets.
 *
 * The HTTP host upgrades a connection and hands the runtime the `ws` socket;
 * this host adopts it under the runtime's tags, enumerates it, answers the
 * platform-level keepalive without waking the runtime, and forwards message,
 * close, and error events to the session server with the signatures the
 * Durable Object adapter uses. Events from one socket are delivered one at a
 * time in arrival order. Ordering across sockets, requests, and alarms is the
 * session executor's concern; it is whatever `bind` receives.
 */

import { WebSocket as NodeWebSocket, type RawData } from "ws";
import type { Logger } from "../logger";
import type { SessionSocket } from "../platform-ports";
import type { SocketHost } from "../session/platform";

/** The session server's socket entry points, as the host delivers them. */
export interface SocketEvents {
  onMessage(ws: SessionSocket, message: string | ArrayBuffer): Promise<void>;
  onClose(ws: SessionSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  onError(ws: SessionSocket, error: Error): void;
}

/** RFC 6455 close code for a connection lost without a close frame. */
const ABNORMAL_CLOSURE = 1006;

export class NodeSocketHost implements SocketHost {
  /** Tags outlive the socket's presence in `sockets()`: a closing socket still classifies. */
  private readonly tagsOf = new WeakMap<SessionSocket, readonly string[]>();
  private readonly open = new Set<NodeWebSocket>();
  private readonly deliveries = new WeakMap<SessionSocket, Promise<void>>();
  private autoResponse: { request: string; response: string } | null = null;
  private events: SocketEvents | null = null;

  constructor(private readonly log: Logger) {}

  /**
   * Route every accepted socket's events to `events`. Binding precedes the
   * first accept by construction: sockets are accepted through the runtime,
   * and the runtime is what gets bound.
   */
  bind(events: SocketEvents): void {
    if (this.events) throw new Error("NodeSocketHost is already bound");
    this.events = events;
  }

  accept(ws: SessionSocket, tags: string[]): void {
    const events = this.events;
    if (!events) throw new Error("NodeSocketHost.accept called before bind");
    const socket = upgradedSocket(ws);
    if (this.tagsOf.has(socket)) throw new Error("Socket was already accepted");
    if (socket.readyState !== NodeWebSocket.OPEN) {
      throw new Error("Cannot accept a socket that is not open");
    }
    this.tagsOf.set(socket, [...tags]);
    this.open.add(socket);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.deliver(socket, () => events.onMessage(socket, toArrayBuffer(data)));
        return;
      }
      const text = toText(data);
      const auto = this.autoResponse;
      if (auto && text === auto.request) {
        socket.send(auto.response);
        return;
      }
      this.deliver(socket, () => events.onMessage(socket, text));
    });
    socket.on("error", (error) => {
      this.deliver(socket, async () => events.onError(socket, error));
    });
    socket.on("close", (code, reason) => {
      this.open.delete(socket);
      this.deliver(socket, () =>
        events.onClose(socket, code, reason.toString(), code !== ABNORMAL_CLOSURE)
      );
    });
  }

  tags(ws: SessionSocket): string[] {
    return [...(this.tagsOf.get(ws) ?? [])];
  }

  sockets(tag?: string): SessionSocket[] {
    const accepted = [...this.open];
    if (tag === undefined) return accepted;
    return accepted.filter((socket) => this.tagsOf.get(socket)?.includes(tag));
  }

  setAutoResponse(request: string, response: string): void {
    this.autoResponse = { request, response };
  }

  /** Run `handle` after this socket's earlier events settle; a failure is logged and never stalls the socket. */
  private deliver(socket: NodeWebSocket, handle: () => Promise<void>): void {
    const previous = this.deliveries.get(socket) ?? Promise.resolve();
    const next = previous.then(handle).catch((error: unknown) => {
      this.log.error("socket.delivery_failed", {
        event: "socket.delivery_failed",
        tags: this.tags(socket),
        error: error instanceof Error ? error : String(error),
      });
    });
    this.deliveries.set(socket, next);
  }
}

/**
 * The core types its sockets structurally; only sockets this host's server
 * upgraded ever reach it, so anything else is a wiring error rather than a
 * socket to adopt.
 */
function upgradedSocket(ws: SessionSocket): NodeWebSocket {
  if (!(ws instanceof NodeWebSocket)) {
    throw new TypeError("NodeSocketHost received a socket it did not upgrade");
  }
  return ws;
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

function toText(data: RawData): string {
  return toBuffer(data).toString("utf8");
}

/** The frame's bytes as a standalone ArrayBuffer, the shape the Workers runtime delivers. */
function toArrayBuffer(data: RawData): ArrayBuffer {
  const buffer = toBuffer(data);
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}
