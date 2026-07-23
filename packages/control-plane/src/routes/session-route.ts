import type { SessionRuntimeClient } from "../session/runtime-client";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import type { RequestContext, Route } from "./shared";

export type SessionRouteContext = RequestContext & {
  sessionRuntime: SessionRuntimeClient;
};

export type SessionRouteHandler = (
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
) => Promise<Response>;

export function withSessionRuntime(handler: SessionRouteHandler): Route["handler"] {
  return (request, env, match, ctx) =>
    handler(request, env, match, {
      ...ctx,
      sessionRuntime: createSessionRuntimeClient(env, ctx),
    });
}

export function sessionRoute(
  route: Omit<Route, "handler"> & { handler: SessionRouteHandler }
): Route {
  return { ...route, handler: withSessionRuntime(route.handler) };
}
