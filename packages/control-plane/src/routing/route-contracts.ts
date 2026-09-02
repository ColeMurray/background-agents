/** Enumerate the routes an app registered, with the policy each admits under. */

import type { RouterRoute } from "hono/types";
import type { AdmissionPolicy } from "./admit";

/** One registered route as the policy tests and the boundary suites see it. */
export type RouteContract = { method: string; path: string } & AdmissionPolicy;

function admissionPolicyOf(handler: RouterRoute["handler"]): AdmissionPolicy | undefined {
  return "policy" in handler ? (handler.policy as AdmissionPolicy) : undefined;
}

/**
 * Every route in registration order, read from Hono's own route list: the
 * entry whose handler is the `admit()` middleware names the method, the
 * mounted path, and the policy.
 */
export function listRouteContracts(app: { routes: readonly RouterRoute[] }): RouteContract[] {
  return app.routes.flatMap((route) => {
    const policy = admissionPolicyOf(route.handler);
    return policy ? [{ method: route.method, path: route.path, ...policy }] : [];
  });
}
