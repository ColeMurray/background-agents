/**
 * Admission-policy registry for natively registered Hono routes.
 *
 * A catalog entry carries its policy as a required field, so a route cannot
 * exist without one. Native `app.on(method, path, ...)` registration has no
 * such field: the policy travels as a middleware in the handler chain. This
 * registry tags that middleware with its policy and walks `app.routes` at
 * build time so a route registered without one refuses to build.
 *
 * Hono runs the handlers matched for a request in registration order and
 * stops at the first one that returns without calling `next`. The check is
 * therefore positional: the first handler registered for a method+path must
 * be the tagged policy, so nothing can answer the request ahead of admission.
 * Only `app.use()` entries (method `ALL`) may precede it; those are app-owned
 * infrastructure such as the request lifecycle and the guards.
 */

import type { RouterRoute } from "hono/types";
import { COMPOSED_HANDLER } from "hono/utils/constants";
import type { RouteAdmissionPolicy } from "../routes/shared";

type RegisteredHandler = RouterRoute["handler"];

const policies = new WeakMap<RegisteredHandler, RouteAdmissionPolicy>();

/** Tag the middleware that enforces `policy` so the completeness walk can find it. */
export function registerRoutePolicy<Handler extends RegisteredHandler>(
  middleware: Handler,
  policy: RouteAdmissionPolicy
): Handler {
  policies.set(middleware, policy);
  return middleware;
}

/**
 * Mounting a sub-app that owns an error handler wraps each of its handlers;
 * Hono keeps the original reachable so the tag survives the wrap.
 */
function unwrap(handler: RegisteredHandler): RegisteredHandler {
  const composed = (handler as Partial<Record<typeof COMPOSED_HANDLER, RegisteredHandler>>)[
    COMPOSED_HANDLER
  ];
  return composed ?? handler;
}

/** The policy a registered handler enforces, if it was tagged. */
export function routePolicyOf(handler: RegisteredHandler): RouteAdmissionPolicy | undefined {
  return policies.get(unwrap(handler));
}

export interface RouteCompletenessOptions {
  /** `METHOD /path` identities that intentionally admit without a policy, such as CORS preflight. */
  exempt?: readonly string[];
}

/**
 * Registered method+path identities whose first handler is not a tagged policy.
 *
 * `app.use()` registers with method `ALL`; those entries are middleware ahead
 * of a route, never the route itself, so they are neither counted nor credited.
 */
export function missingRoutePolicies(
  app: { routes: readonly RouterRoute[] },
  options: RouteCompletenessOptions = {}
): string[] {
  const exempt = new Set(options.exempt ?? []);
  const first = new Map<string, boolean>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const identity = `${route.method} ${route.path}`;
    if (first.has(identity)) continue;
    first.set(identity, routePolicyOf(route.handler) !== undefined);
  }
  return [...first]
    .filter(([identity, admits]) => !admits && !exempt.has(identity))
    .map(([id]) => id);
}

/** Refuse to build an app that registers a route whose chain does not begin with a policy. */
export function assertEveryRouteAdmits(
  app: { routes: readonly RouterRoute[] },
  options: RouteCompletenessOptions = {}
): void {
  const missing = missingRoutePolicies(app, options);
  if (missing.length > 0) {
    throw new Error(
      `Routes whose handler chain does not begin with an admission policy: ${missing.join(", ")}`
    );
  }
}
