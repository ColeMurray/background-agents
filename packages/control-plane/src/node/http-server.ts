/**
 * The Node host's HTTP server: the control-plane app behind a fetch
 * listener, `/healthz` answered ahead of it, and WebSocket upgrades routed
 * to the session upgrade path.
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
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
}

/** The health response: 200 while serving, 503 while draining. */
function healthResponse(report: HealthReport): Response {
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createNodeHttpServer(options: NodeHttpServerOptions): Server {
  const listener = getRequestListener((request) => {
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      new URL(request.url).pathname === "/healthz"
    ) {
      return healthResponse(options.health());
    }
    return options.fetch(request);
  });
  const server = createServer(listener);
  server.on("upgrade", (request, socket, head) => {
    void options.upgrade(request, socket, head);
  });
  return server;
}
