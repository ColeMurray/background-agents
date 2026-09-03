import type { Principal } from "../auth/principal";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import type { AdmissionPolicy } from "./admit";

const logger = createLogger("router");

/** Rebuild a response once with the common headers plus any route-owned overrides. */
function withCommonHeaders(
  response: Response,
  ctx: RequestContext,
  overrides?: Record<string, string>
): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("x-request-id", ctx.request_id);
  headers.set("x-trace-id", ctx.trace_id);
  for (const [name, value] of Object.entries(overrides ?? {})) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Add the response headers shared by all ordinary HTTP route responses. */
export function withCorsAndTraceHeaders(response: Response, ctx: RequestContext): Response {
  return withCommonHeaders(response, ctx);
}

/** Apply all matched-route response policy in one body-preserving reconstruction. */
export function finalizeRouteResponse(
  response: Response,
  route: Pick<AdmissionPolicy, "cacheControl">,
  ctx: RequestContext
): Response {
  return withCommonHeaders(
    response,
    ctx,
    route.cacheControl ? { "Cache-Control": route.cacheControl } : undefined
  );
}

/** Emit verified principal attribution without credential material. */
export function logPrincipal(principal: Principal, ctx: RequestContext, path: string): void {
  const fields: Record<string, string | undefined> = { principal_kind: principal.kind };
  switch (principal.kind) {
    case "service":
      fields.auth_scheme = "per-service";
      // `service` is reserved by the shared logger, so the bot name needs its own key.
      fields.principal_service = principal.service;
      fields.actor = principal.actor?.participantUserId;
      break;
    case "sandbox":
      fields.session_id = principal.sessionId;
      break;
    case "user":
      fields.user_id = principal.userId;
      break;
  }
  logger.info("auth.principal", {
    event: "auth.principal",
    ...fields,
    http_path: path,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}

/** Emit the request completion wide event with accumulated request metrics. */
export function logRequest(
  response: Response,
  ctx: RequestContext,
  method: string,
  path: string,
  startTime: number
): void {
  logger.info("http.request", {
    event: "http.request",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    http_method: method,
    http_path: path,
    http_status: response.status,
    duration_ms: Date.now() - startTime,
    outcome: response.status >= 500 ? "error" : "success",
    ...ctx.metrics.summarize(),
  });
}
