import type { RequestContext } from "../http/request-context";
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
