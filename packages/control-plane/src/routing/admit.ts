/** Route admission as Hono middleware over the framework-neutral admission pipeline. */

import type { MiddlewareHandler } from "hono";
import { auditRouteAuthorizationDecision } from "../authorization/request-audit";
import type {
  RouteAdmissionPolicy,
  RouteAuthentication,
  RouteContext,
  RouteDefinition,
  RouteParams,
} from "../routes/shared";
import type { Env } from "../types";
import type { ControlPlaneHonoEnv } from "./hono-env";
import { admitRoute, type RouteAdmissionResult } from "./route-admission";
import { rawRouteParams } from "./route-params";

/** Everything admission and response policy need to know about a route. */
export type AdmissionPolicy = RouteAdmissionPolicy & Pick<RouteDefinition, "cacheControl">;

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
export type AdmittedEnv<Policy extends AdmissionPolicy> = {
  Bindings: Env;
  Variables: ControlPlaneHonoEnv["Variables"] & { admitted: Admitted<Policy["authentication"]> };
};

/** The middleware `admit()` returns, carrying the policy it enforces for route enumeration. */
export type AdmitMiddleware<Policy extends AdmissionPolicy> = MiddlewareHandler<
  AdmittedEnv<Policy>
> & { readonly policy: Policy };

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

  const middleware: MiddlewareHandler<AdmittedEnv<Policy>> = async (c, next) => {
    const context = c.get("requestContext");
    const pathname = c.req.path;
    // Recorded before anything can fail so the lifecycle finalizes an
    // admission error with this route's response policy.
    c.set("routePolicy", policy);
    const params = rawRouteParams(c.req.routePath, pathname);
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
