/** Route admission as Hono middleware over the framework-neutral admission pipeline. */

import type { Context as HonoContext, MiddlewareHandler } from "hono";
import type { ParamKeys, ParamKeyToRecord } from "hono/types";
import type { Simplify, UnionToIntersection } from "hono/utils/types";
import { auditRouteAuthorizationDecision } from "../authorization/request-audit";
import type { RequestContext } from "../http/request-context";
import { error } from "../http/responses";
import type {
  RouteAdmissionPolicy,
  RouteAuthentication,
  RouteContext,
  RouteParams,
} from "../routes/shared";
import type { Env } from "../types";
import type { ControlPlaneHonoEnv } from "./hono-env";
import { admitRoute, type RouteAdmissionResult } from "./route-admission";
import { rawRouteParams } from "./route-params";

/** Everything admission and response policy need to know about a route. */
export type AdmissionPolicy = RouteAdmissionPolicy & {
  cacheControl?: "no-store" | "private, no-store";
};

/** The evaluated policy for the current request, read by the lifecycle. */
export interface RouteAdmission {
  policy: AdmissionPolicy;
  params: RouteParams;
  result: RouteAdmissionResult;
}

/** What an admitted handler receives: the request as authenticated, and the context narrowed by the policy. */
export interface Admitted<Authentication extends RouteAuthentication> {
  request: Request;
  ctx: RouteContext<Authentication>;
}

/** The Hono environment a handler behind `admit(policy)` sees. */
export type AdmittedEnv<Authentication extends RouteAuthentication> = {
  Bindings: Env;
  Variables: ControlPlaneHonoEnv["Variables"] & { admitted: Admitted<Authentication> };
};

/** The middleware `admit()` returns, carrying the policy it enforces for route enumeration. */
export type AdmitMiddleware<Policy extends AdmissionPolicy> = MiddlewareHandler<
  AdmittedEnv<Policy["authentication"]>
> & { readonly policy: Policy };

/** The path parameters Hono decodes for a route path, typed from its `:param` segments. */
export type PathParams<Path extends string> = Simplify<
  UnionToIntersection<ParamKeyToRecord<ParamKeys<Path>>>
>;

/** The Hono environment a route handler needs: admission ran, and its context has the shape the handler asks for. */
export type HandlerEnv<Context extends RequestContext> = {
  Bindings: Env;
  Variables: ControlPlaneHonoEnv["Variables"] & { admitted: { request: Request; ctx: Context } };
};

/**
 * Run a route handler for an admitted request.
 *
 * The one place a Hono context is unpacked for a handler. The parameter
 * type comes from the route's path literal and the context type is checked
 * against what the route's policy produces, so a handler wired to a path
 * without its parameters, or behind a policy that cannot produce the
 * context it asks for, fails to compile.
 */
export function dispatch<Context extends RequestContext, Path extends string>(
  c: HonoContext<HandlerEnv<Context>, Path>,
  handler: (request: Request, env: Env, params: PathParams<Path>, ctx: Context) => Promise<Response>
): Promise<Response> {
  return handler(c.var.admitted.request, c.env, c.req.param(), c.var.admitted.ctx);
}

/**
 * Hono's parameter decoder leaves a segment it cannot decode as it arrived,
 * so a malformed escape would otherwise reach the handler as data. The raw
 * segments are checked once here; the decoded values are never re-decoded.
 */
function malformedSegment(routePath: string, pathname: string): boolean {
  return Object.values(rawRouteParams(routePath, pathname)).some((segment) => {
    if (!segment.includes("%")) return false;
    try {
      decodeURIComponent(segment);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Evaluate `policy` for the selected route before its handler runs.
 *
 * Denials answer here: an authorization denial is audited before anything is
 * logged, and the lifecycle middleware then logs and decorates the response.
 * The middleware is built once per route at app construction, which is when
 * a policy that cannot be enforced is refused.
 */
export function admit<const Policy extends AdmissionPolicy>(
  policy: Policy
): AdmitMiddleware<Policy> {
  const principalless =
    policy.authentication.kind === "public" ||
    policy.authentication.kind === "handler-authenticated";
  if (principalless && policy.authorization.kind !== "none") {
    throw new Error("Route without a verified principal cannot require authorization");
  }

  const middleware: MiddlewareHandler<AdmittedEnv<Policy["authentication"]>> = async (c, next) => {
    const context = c.get("requestContext");
    const pathname = c.req.path;
    // Recorded before anything can fail so the lifecycle finalizes an
    // admission error with this route's response policy.
    c.set("routePolicy", policy);
    if (malformedSegment(c.req.routePath, pathname)) {
      const result: RouteAdmissionResult = {
        kind: "denied",
        response: error("Invalid path encoding", 400),
        requestLog: "emit",
      };
      c.set("admission", { policy, params: {}, result });
      return result.response;
    }
    // Hono decodes each segment exactly once; admission reads those values.
    const params = c.req.param() as RouteParams;
    const result = await admitRoute({
      request: c.req.raw,
      env: c.env,
      policy,
      params,
      pathname,
      ctx: context,
    });
    c.set("admission", { policy, params, result });

    if (result.kind === "denied") {
      if (result.decision) {
        await auditRouteAuthorizationDecision({
          ctx: context,
          method: c.req.raw.method,
          path: pathname,
          response: result.response,
          decision: result.decision,
        });
      }
      return result.response;
    }
    c.set("admitted", {
      request: result.handlerRequest,
      ctx: context as RouteContext<Policy["authentication"]>,
    });
    await next();
  };
  return Object.assign(middleware, { policy });
}
