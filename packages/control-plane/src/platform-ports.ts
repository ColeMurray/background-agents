import type { FetchClient } from "@open-inspect/shared/service-auth";

export type { FetchClient } from "@open-inspect/shared/service-auth";

/** Capability consumed by application services that defer background work. */
export interface BackgroundTasks {
  /**
   * Start `task` and let it run past the current request. The factory is
   * invoked synchronously inside `submit`, and a synchronous throw is absorbed
   * and logged exactly like a rejection — building the task can never fail the
   * caller.
   */
  submit(
    task: () => Promise<unknown>,
    metadata: { name: string; context?: Record<string, unknown> }
  ): void;
}

/**
 * The socket surface the session core uses. Structural on purpose: the
 * Cloudflare host hands the runtime hibernatable `WebSocket`s and the Node
 * host hands it `ws` sockets, and the core compiles against both without
 * naming a member only one platform has. `readyState` uses the standard
 * CONNECTING/OPEN/CLOSING/CLOSED values on both.
 */
export interface SessionWebSocket {
  readonly readyState: number;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/** The RFC 6455 OPEN ready state; every platform's socket reports this value. */
const SOCKET_OPEN = 1;

/** Whether `socket` can currently send and receive. */
export function isSocketOpen(socket: SessionWebSocket): boolean {
  return socket.readyState === SOCKET_OPEN;
}

/** Access the runtime's single scheduled wake-up. */
export interface AlarmScheduler {
  schedule(at: number): Promise<void>;
  cancel(): Promise<void>;
  current(): Promise<number | null>;
}

// Keep platform compatibility checked at the boundary rather than widening every consumer.
type _AssertExtends<A extends B, B> = A;
type _FetcherSatisfiesFetchClient = _AssertExtends<Fetcher, FetchClient>;
