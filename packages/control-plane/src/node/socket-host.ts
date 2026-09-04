/**
 * NodeWebSocketHost — the session's `SessionWebSocketHost` over `ws` sockets.
 *
 * The HTTP host upgrades a connection and hands the runtime the `ws` socket;
 * this host adopts it under the runtime's tags, enumerates it, answers the
 * platform-level keepalive without waking the runtime, and forwards message,
 * close, and error events to the session server with the signatures the
 * Durable Object adapter uses.
 *
 * Unlike the Durable Object runtime, this host owns inbound flow control.
 * Events from one socket are delivered one at a time in arrival order. The
 * socket is paused before each delivery starts and resumed when its queue
 * empties, so the peer's bytes wait in the kernel rather than on the heap;
 * only the frames `ws` had already decoded from the read in progress queue
 * behind an in-flight delivery, up to `maxPendingDeliveries`. A peer that
 * exceeds that bound is closed with 1013. A handler that never settles holds
 * only its own socket; bounding handler time is the session executor's
 * concern, which is whatever `bindEventSink` receives.
 *
 * A host and the runtime it is bound to share one lifetime: the registry
 * builds them together and retires them together, and a runtime with open
 * sockets is never retired underneath them. There is no re-binding.
 */

import { WebSocket as NodeWebSocket, type RawData } from "ws";
import type { Logger } from "../logger";
import type { SessionWebSocket } from "../platform-ports";
import type { SessionWebSocketHost } from "../session/platform";

/** The session server's socket entry points, as the host delivers them. */
export interface SessionWebSocketEventSink {
  onMessage(ws: SessionWebSocket, message: string | ArrayBuffer): Promise<void>;
  onClose(ws: SessionWebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  onError(ws: SessionWebSocket, error: Error): void;
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

export class NodeWebSocketHost implements SessionWebSocketHost {
  /** Tags outlive the socket's presence in `sockets()`: a closing socket still classifies. */
  private readonly tagsOf = new WeakMap<SessionWebSocket, readonly string[]>();
  private readonly open = new Set<NodeWebSocket>();
  private readonly deliveries = new WeakMap<NodeWebSocket, Deliveries>();
  private readonly maxPendingDeliveries: number;
  private autoResponse: { request: string; response: string } | null = null;
  private events: SessionWebSocketEventSink | null = null;

  constructor(
    private readonly log: Logger,
    options: NodeSocketHostOptions = {}
  ) {
    this.maxPendingDeliveries = options.maxPendingDeliveries ?? DEFAULT_MAX_PENDING_DELIVERIES;
  }

  /**
   * Route every adopted socket's events to `sink`, once. Binding precedes
   * the first adoption by construction: sockets are adopted through the
   * runtime, and the runtime is what gets bound.
   */
  bindEventSink(sink: SessionWebSocketEventSink): void {
    if (this.events) throw new Error("NodeWebSocketHost is already bound");
    this.events = sink;
  }

  adopt(ws: SessionWebSocket, tags: string[]): void {
    const events = this.events;
    if (!events) throw new Error("NodeWebSocketHost.adopt called before bindEventSink");
    const socket = requireNodeWebSocket(ws);
    if (this.tagsOf.has(socket)) throw new Error("Socket was already adopted");
    if (socket.readyState !== NodeWebSocket.OPEN) {
      throw new Error("Cannot adopt a socket that is not open");
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

  tags(ws: SessionWebSocket): string[] {
    return [...(this.tagsOf.get(ws) ?? [])];
  }

  sockets(tag?: string): SessionWebSocket[] {
    const accepted = [...this.open];
    if (tag === undefined) return accepted;
    return accepted.filter((socket) => this.tagsOf.get(socket)?.includes(tag));
  }

  setAutoResponse(request: string, response: string): void {
    this.autoResponse = { request, response };
  }

  /** Queue `handle` behind this socket's earlier events; the socket stays paused until the queue empties. */
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
    if (deliveries.draining) return;
    void this.drain(socket, deliveries);
  }

  private async drain(socket: NodeWebSocket, deliveries: Deliveries): Promise<void> {
    deliveries.draining = true;
    // Pause before the first delivery, not the second: otherwise `ws` keeps
    // reading and assembles the next message (up to maxPayload) on the heap
    // while the runtime is busy.
    socket.pause();
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
function requireNodeWebSocket(ws: SessionWebSocket): NodeWebSocket {
  if (!(ws instanceof NodeWebSocket)) {
    throw new TypeError("NodeWebSocketHost received a socket it did not upgrade");
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
