/**
 * The Node host's HTTP server: the control-plane app behind a fetch
 * listener, `/healthz` answered ahead of it, and WebSocket upgrades routed
 * to the session upgrade path.
 *
 * Requests the app is handling are tracked so a shutdown can wait for them:
 * `server.close()` only stops new connections, and a handler that has
 * yielded resumes after it. The upgrade boundary is total: whatever the
 * upgrade path throws is logged and the raw socket is destroyed, so no
 * failure becomes an unhandled rejection and no peer is left hanging.
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import type { Logger } from "../logger";
import { settlesWithin } from "./background-tasks";
import type { UpgradeHandler } from "./websocket-upgrade";

/** What the host reports about itself; a checker reads `status`. */
export interface HealthReport {
  /** `draining` once a shutdown has begun: the load balancer should send nothing further. */
  status: "ok" | "draining";
  uptime_s: number;
  /** The global store's migrations applied at boot, by count. */
  migrations_applied: number;
  sessions_resident: number;
  background_tasks: number;
  alarm_clock: "running" | "stopped";
  cron: "running" | "stopped";
}

export interface NodeHttpServerOptions {
  /** Ordinary requests: the control-plane app. */
  fetch: (request: Request) => Promise<Response>;
  upgrade: UpgradeHandler;
  health: () => HealthReport;
  log: Logger;
}

export interface NodeHttpServer {
  readonly server: Server;
  /** Requests the app is handling right now. */
  readonly inFlight: number;
  /**
   * Wait for every request in flight, including ones accepted meanwhile,
   * for at most `timeoutMs`. Requests still running at the deadline are
   * left to the caller; returns how many there were.
   */
  drain(timeoutMs: number): Promise<number>;
}

/** The health response: 200 while serving, 503 while draining. */
function healthResponse(report: HealthReport): Response {
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createNodeHttpServer(options: NodeHttpServerOptions): NodeHttpServer {
  const { log } = options;
  const inFlight = new Set<Promise<void>>();

  const listener = getRequestListener((request) => {
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      new URL(request.url).pathname === "/healthz"
    ) {
      return healthResponse(options.health());
    }
    const pending = options.fetch(request);
    // Tracked as settled-or-not only; the outcome, a rejection included,
    // is the listener's to answer.
    const tracked: Promise<void> = pending
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    return pending;
  });

  const server = createServer(listener);
  server.on("upgrade", (request, socket, head) => {
    options.upgrade(request, socket, head).catch((error: unknown) => {
      log.error("WebSocket upgrade path failed", {
        event: "ws.upgrade_failed",
        http_path: request.url,
        error: error instanceof Error ? error : String(error),
      });
      socket.destroy();
    });
  });

  return {
    server,
    get inFlight() {
      return inFlight.size;
    },
    async drain(timeoutMs: number): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await settlesWithin([...inFlight], remaining))) break;
      }
      if (inFlight.size > 0) {
        log.warn("http.drain_timeout", {
          event: "http.drain_timeout",
          timeout_ms: timeoutMs,
          pending: inFlight.size,
        });
      }
      return inFlight.size;
    },
  };
}
