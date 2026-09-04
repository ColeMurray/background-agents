/**
 * NodeSocketHost — the session's `SocketHost` over `ws` sockets.
 *
 * The HTTP host upgrades a connection and hands the runtime the `ws` socket;
 * this host adopts it under the runtime's tags, enumerates it, answers the
 * platform-level keepalive without waking the runtime, and forwards message,
 * close, and error events to the session server with the signatures the
 * Durable Object adapter uses.
 *
 * Unlike the Durable Object runtime, this host owns inbound flow control.
 * Events from one socket are delivered one at a time in arrival order; while
 * a delivery is in flight the socket is paused so the peer's bytes wait in
 * the kernel rather than on the heap, and the frames `ws` had already parsed
 * queue behind it up to `maxPendingDeliveries`. A peer that exceeds that
 * bound is closed with 1013. A handler that never settles holds only its own
 * socket; bounding handler time is the session executor's concern, which is
 * whatever `bind` receives.
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

export interface NodeSocketHostOptions {
  /**
   * Frames a socket may hold parsed but undelivered while an earlier
   * delivery is in flight. Pausing stops the next read, so this backlog is
   * whatever `ws` decodes from one read that was already in progress: its
   * bytes are bounded by that read, and its count by how small the peer
   * makes its frames. The default is well above what realistically sized
   * frames fit in one read; a peer that fills a read with thousands of
   * near-empty frames is closed. Payload size per frame is the upgrade
   * server's `maxPayload`, not this host's concern.
   */
  maxPendingDeliveries?: number;
}

const DEFAULT_MAX_PENDING_DELIVERIES = 4096;

/** RFC 6455 "try again later": the server cannot keep up with this peer. */
export const BACKLOG_EXCEEDED_CLOSE_CODE = 1013;

interface Deliveries {
  queue: Array<() => Promise<void>>;
  draining: boolean;
}

export class NodeSocketHost implements SocketHost {
  /** Tags outlive the socket's presence in `sockets()`: a closing socket still classifies. */
  private readonly tagsOf = new WeakMap<SessionSocket, readonly string[]>();
  private readonly open = new Set<NodeWebSocket>();
  private readonly deliveries = new WeakMap<NodeWebSocket, Deliveries>();
  private readonly maxPendingDeliveries: number;
  private autoResponse: { request: string; response: string } | null = null;
  private events: SocketEvents | null = null;

  constructor(
    private readonly log: Logger,
    options: NodeSocketHostOptions = {}
  ) {
    this.maxPendingDeliveries = options.maxPendingDeliveries ?? DEFAULT_MAX_PENDING_DELIVERIES;
  }

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
      // Frames still arriving after this side began closing are dropped: the
      // Durable Object runtime delivers nothing after close() either, and a
      // peer closed for backlog must not refill the queue.
      if (socket.readyState !== NodeWebSocket.OPEN) return;
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
    // The standards-style event carries `wasClean` as `ws` computes it (a
    // close frame both received and sent); the emitter-style event does not.
    socket.addEventListener("close", (event) => {
      this.open.delete(socket);
      this.deliver(socket, () => events.onClose(socket, event.code, event.reason, event.wasClean));
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

  /** Queue `handle` behind this socket's earlier events, pausing the socket while any are in flight. */
  private deliver(socket: NodeWebSocket, handle: () => Promise<void>): void {
    let deliveries = this.deliveries.get(socket);
    if (!deliveries) {
      deliveries = { queue: [], draining: false };
      this.deliveries.set(socket, deliveries);
    }
    if (deliveries.queue.length >= this.maxPendingDeliveries) {
      this.log.warn("socket.backlog_exceeded", {
        event: "socket.backlog_exceeded",
        tags: this.tags(socket),
        pending: deliveries.queue.length,
      });
      deliveries.queue.length = 0;
      socket.close(BACKLOG_EXCEEDED_CLOSE_CODE, "Message backlog exceeded");
      // The socket was paused for the in-flight delivery, which may never
      // settle; the closing handshake still has to read the peer's frame.
      socket.resume();
      return;
    }
    deliveries.queue.push(handle);
    if (deliveries.draining) {
      socket.pause();
      return;
    }
    void this.drain(socket, deliveries);
  }

  private async drain(socket: NodeWebSocket, deliveries: Deliveries): Promise<void> {
    deliveries.draining = true;
    try {
      let handle = deliveries.queue.shift();
      while (handle) {
        try {
          await handle();
        } catch (error: unknown) {
          this.log.error("socket.delivery_failed", {
            event: "socket.delivery_failed",
            tags: this.tags(socket),
            error: error instanceof Error ? error : String(error),
          });
        }
        handle = deliveries.queue.shift();
      }
    } finally {
      deliveries.draining = false;
      socket.resume();
    }
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
