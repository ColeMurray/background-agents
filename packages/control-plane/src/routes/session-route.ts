import type { SessionRuntimeClient } from "../session/runtime-client";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import type { RequestContext, RouteDefinition } from "./shared";

export type SessionRouteContext = RequestContext & {
  sessionRuntime: SessionRuntimeClient;
};

export type SessionRouteHandler = (
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
) => Promise<Response>;

function withSessionRuntime(handler: SessionRouteHandler): RouteDefinition["handler"] {
  return (request, env, match, ctx) =>
    handler(request, env, match, {
      ...ctx,
      sessionRuntime: createSessionRuntimeClient(env, ctx),
    });
}

export function sessionRoute(
  route: Omit<RouteDefinition, "handler"> & { handler: SessionRouteHandler }
): RouteDefinition {
  return { ...route, handler: withSessionRuntime(route.handler) };
}
