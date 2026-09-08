import type { Logger } from "../../logger";
import type { Clock } from "../ports";
import { requestLogger } from "../request-logger";
import type { SessionInternalRoute } from "./routes";

export interface SessionHttpDispatcherDeps {
  log: Logger;
  routes: readonly SessionInternalRoute[];
  clock: Clock;
}

/** Dispatches the platform-neutral HTTP surface for one session. */
export class SessionHttpDispatcher {
  constructor(private readonly deps: SessionHttpDispatcherDeps) {}

  async dispatch(request: Request): Promise<Response> {
    const fetchStart = this.deps.clock.monotonicNowMs();
    const log = requestLogger(this.deps.log, request);
    const url = new URL(request.url);
    const path = url.pathname;

    // Unmatched routes are not route metrics. WebSocket upgrades never reach
    // this dispatcher: the host completes them against `SessionUpgradeAdmission`.
    const route = this.deps.routes.find(
      (candidate) => candidate.path === path && candidate.method === request.method
    );
    if (!route) return new Response("Not Found", { status: 404 });

    const handlerStart = this.deps.clock.monotonicNowMs();
    let status = 500;
    let outcome: "success" | "error" = "error";
    try {
      const response = await route.handler(request, url, log);
      status = response.status;
      outcome = status >= 500 ? "error" : "success";
      return response;
    } catch (error) {
      status = 500;
      outcome = "error";
      throw error;
    } finally {
      const handlerMs = this.deps.clock.monotonicNowMs() - handlerStart;
      const totalMs = this.deps.clock.monotonicNowMs() - fetchStart;
      log.info("do.request", {
        event: "do.request",
        http_method: request.method,
        http_path: path,
        http_status: status,
        duration_ms: Math.round(totalMs * 100) / 100,
        handler_ms: Math.round(handlerMs * 100) / 100,
        outcome,
      });
    }
  }
}
