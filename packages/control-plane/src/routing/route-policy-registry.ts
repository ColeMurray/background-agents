/**
 * Admission-policy registry for natively registered Hono routes.
 *
 * A catalog entry carries its policy as a required field, so a route cannot
 * exist without one. Native `app.on(method, path, ...)` registration has no
 * such field: the policy travels as a middleware in the handler chain. This
 * registry tags that middleware with its policy and walks `app.routes` at
 * build time so a route registered without one refuses to build.
 */

import type { RouterRoute } from "hono/types";
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

/** The policy a registered handler enforces, if it was tagged. */
export function routePolicyOf(handler: RegisteredHandler): RouteAdmissionPolicy | undefined {
  return policies.get(handler);
}

export interface RouteCompletenessOptions {
  /** `METHOD /path` identities that intentionally admit without a policy, such as CORS preflight. */
  exempt?: readonly string[];
}

/**
 * Registered method+path identities whose handler chain carries no tagged policy.
 *
 * `app.use()` registers with method `ALL`; those entries are middleware ahead
 * of a route, never the route itself, so they are neither counted nor credited.
 */
export function missingRoutePolicies(
  app: { routes: readonly RouterRoute[] },
  options: RouteCompletenessOptions = {}
): string[] {
  const exempt = new Set(options.exempt ?? []);
  const identities: string[] = [];
  const admitted = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const identity = `${route.method} ${route.path}`;
    if (!identities.includes(identity)) identities.push(identity);
    if (policies.has(route.handler)) admitted.add(identity);
  }
  return identities.filter((identity) => !admitted.has(identity) && !exempt.has(identity));
}

/** Refuse to build an app that registers a route without an admission policy. */
export function assertEveryRouteAdmits(
  app: { routes: readonly RouterRoute[] },
  options: RouteCompletenessOptions = {}
): void {
  const missing = missingRoutePolicies(app, options);
  if (missing.length > 0) {
    throw new Error(`Routes registered without an admission policy: ${missing.join(", ")}`);
  }
}
