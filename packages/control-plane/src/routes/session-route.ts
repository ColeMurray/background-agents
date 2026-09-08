import type { Context as HonoContext } from "hono";
import type { RequestContext } from "../http/request-context";
import { dispatch, type HandlerEnv, type PathParams } from "../routing/admit";
import { createSessionRuntimeClient, type SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";

export type SessionRouteContext = RequestContext & {
  sessionRuntime: SessionRuntimeClient;
};

/** Give a session route's handler a runtime client bound to this request. */
export function withSessionRuntime<Context extends RequestContext>(
  env: Env,
  ctx: Context
): Context & { sessionRuntime: SessionRuntimeClient } {
  return { ...ctx, sessionRuntime: createSessionRuntimeClient(env, ctx) };
}

/** Run a session handler for an admitted request, with the runtime client bound to it. */
export function dispatchSession<Context extends RequestContext, Path extends string>(
  c: HonoContext<HandlerEnv<Context>, Path>,
  handler: (
    request: Request,
    env: Env,
    params: PathParams<Path>,
    ctx: Context & { sessionRuntime: SessionRuntimeClient }
  ) => Promise<Response>
): Promise<Response> {
  return dispatch<Context, Path>(c, (request, env, params, ctx) =>
    handler(request, env, params, withSessionRuntime(env, ctx))
  );
}
