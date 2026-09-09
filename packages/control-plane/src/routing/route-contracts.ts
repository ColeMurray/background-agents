/** Enumerate the routes an app registered, with the policy each admits under. */

import type { RouterRoute } from "hono/types";
import type { AdmissionPolicy } from "./admit";

/** One registered route as the policy tests and the boundary suites see it. */
export type RouteContract = { method: string; path: string } & AdmissionPolicy;

function admissionPolicyOf(handler: RouterRoute["handler"]): AdmissionPolicy | undefined {
  return "policy" in handler ? (handler.policy as AdmissionPolicy) : undefined;
}

/** App-owned responders that answer without a route policy, by `METHOD /path`. */
const APP_OWNED_RESPONDERS: ReadonlySet<string> = new Set(["OPTIONS /*"]);

/**
 * Every route in registration order, read from Hono's own route list: the
 * first entry registered for a method and path must be the `admit()`
 * middleware, which names the policy. A route whose first handler is not
 * the policy is refused rather than skipped, so the enumeration cannot hide
 * an unadmitted route from the suites that iterate it.
 */
export function listRouteContracts(app: { routes: readonly RouterRoute[] }): RouteContract[] {
  const contracts: RouteContract[] = [];
  const seen = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const identity = `${route.method} ${route.path}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const policy = admissionPolicyOf(route.handler);
    if (policy) {
      contracts.push({ method: route.method, path: route.path, ...policy });
    } else if (!APP_OWNED_RESPONDERS.has(identity)) {
      throw new Error(`Route does not begin with admit(): ${identity}`);
    }
  }
  return contracts;
}
