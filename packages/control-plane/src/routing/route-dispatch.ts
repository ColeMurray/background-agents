/** Execute one raw-path matched route through admission and response policy. */

import {
  auditRouteAuthorizationDecision,
  shouldAuditAllowedDecision,
} from "../authorization/request-audit";
import type { RequestContext } from "../http/request-context";
import { error, HttpError } from "../http/responses";
import { createLogger } from "../logger";
import type { Route } from "../routes/shared";
import type { Env } from "../types";
import { admitRoute } from "./route-admission";
import { finalizeRouteResponse, logRequest } from "./request-lifecycle";

const logger = createLogger("router");

export async function dispatchMatchedRoute(input: {
  request: Request;
  env: Env;
  route: Route;
  match: RegExpMatchArray;
  pathname: string;
  context: RequestContext;
  startedAt: number;
}): Promise<Response> {
  const { env, match, pathname, route, context, startedAt } = input;
  const method = input.request.method;
  const admission = await admitRoute({
    request: input.request,
    env,
    policy: route,
    match,
    pathname,
    ctx: context,
  });

  if (admission.kind === "denied") {
    if (admission.decision) {
      await auditRouteAuthorizationDecision({
        ctx: context,
        method,
        path: pathname,
        response: admission.response,
        decision: admission.decision,
      });
    }
    if (admission.requestLog === "emit") {
      logRequest(admission.response, context, method, pathname, startedAt);
    }
    return finalizeRouteResponse(admission.response, route, context);
  }

  const auditAllowedDecision = async (response: Response): Promise<void> => {
    if (!shouldAuditAllowedDecision(admission.decision)) return;
    await auditRouteAuthorizationDecision({
      ctx: context,
      method,
      path: pathname,
      response,
      decision: admission.decision,
    });
  };

  let response: Response;
  try {
    response = await route.handler(admission.handlerRequest, env, match, context);
  } catch (caught) {
    if (caught instanceof HttpError) {
      response = error(caught.message, caught.status);
    } else {
      logger.error("http.request", {
        event: "http.request",
        request_id: context.request_id,
        trace_id: context.trace_id,
        http_method: method,
        http_path: pathname,
        http_status: 500,
        duration_ms: Date.now() - startedAt,
        outcome: "error",
        error: caught instanceof Error ? caught : String(caught),
        ...context.metrics.summarize(),
      });
      response = error("Internal server error", 500);
      await auditAllowedDecision(response);
      return finalizeRouteResponse(response, route, context);
    }
  }

  logRequest(response, context, method, pathname, startedAt);
  await auditAllowedDecision(response);
  return finalizeRouteResponse(response, route, context);
}
