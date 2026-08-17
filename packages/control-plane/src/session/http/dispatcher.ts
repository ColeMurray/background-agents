import type { Logger } from "../../logger";
import type { Clock } from "../ports";
import type { SessionInternalRoute } from "./routes";

export interface SessionHttpDispatcherDeps {
  ensureInitialized: () => void;
  getLogger: () => Logger;
  routes: readonly SessionInternalRoute[];
  handleWebSocketUpgrade: (request: Request, url: URL, log: Logger) => Promise<Response>;
  clock: Clock;
}

/** Dispatches the platform-neutral HTTP surface for one session. */
export class SessionHttpDispatcher {
  constructor(private readonly deps: SessionHttpDispatcherDeps) {}

  async dispatch(request: Request): Promise<Response> {
    const fetchStart = this.deps.clock.monotonicNowMs();
    this.deps.ensureInitialized();
    const initMs = this.deps.clock.monotonicNowMs() - fetchStart;
    const log = this.requestLogger(request);
    const url = new URL(request.url);
    const path = url.pathname;

    // Preserve the existing contract: upgrades and unmatched routes are not route metrics.
    if (request.headers.get("Upgrade") === "websocket") {
      return this.deps.handleWebSocketUpgrade(request, url, log);
    }

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
        init_ms: Math.round(initMs * 100) / 100,
        handler_ms: Math.round(handlerMs * 100) / 100,
        outcome,
      });
    }
  }

  private requestLogger(request: Request): Logger {
    // Never mutate the session logger with request correlation shared by later callbacks.
    const sessionLog = this.deps.getLogger();
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    if (!traceId && !requestId) return sessionLog;

    const correlationContext: Record<string, unknown> = {};
    if (traceId) correlationContext.trace_id = traceId;
    if (requestId) correlationContext.request_id = requestId;
    return sessionLog.child(correlationContext);
  }
}
