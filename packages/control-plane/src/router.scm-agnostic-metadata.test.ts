import { describe, expect, it } from "vitest";
import { analyticsRoutes } from "./routes/analytics";
import { commitSigningRoutes } from "./routes/commit-signing";
import { sessionDiffRoutes } from "./routes/session-diffs";
import { sessionRuntimeProxyRoutes } from "./routes/session-runtime-proxy";
import type { Route } from "./routes/shared";

function findRoute(routes: Route[], method: string, path: string): Route | undefined {
  return routes.find((route) => route.method === method && route.pattern.test(path));
}

describe("SCM-agnostic route metadata", () => {
  it.each([
    { routes: analyticsRoutes, method: "GET", path: "/analytics/summary" },
    { routes: analyticsRoutes, method: "GET", path: "/analytics/timeseries" },
    { routes: analyticsRoutes, method: "GET", path: "/analytics/breakdown" },
    { routes: analyticsRoutes, method: "GET", path: "/analytics/pull-requests" },
    {
      routes: sessionRuntimeProxyRoutes,
      method: "GET",
      path: "/sessions/session-1/tunnel-urls",
    },
    {
      routes: sessionRuntimeProxyRoutes,
      method: "GET",
      path: "/sessions/session-1/participant-profiles",
    },
    {
      routes: commitSigningRoutes,
      method: "GET",
      path: "/sessions/session-1/commit-signing",
    },
    {
      routes: commitSigningRoutes,
      method: "POST",
      path: "/sessions/session-1/commit-signing",
    },
    { routes: sessionDiffRoutes, method: "GET", path: "/sessions/session-1/diff" },
    { routes: sessionDiffRoutes, method: "PUT", path: "/sessions/session-1/diff" },
    {
      routes: sessionDiffRoutes,
      method: "POST",
      path: "/sessions/session-1/diff/failure",
    },
    {
      routes: sessionDiffRoutes,
      method: "GET",
      path: "/sessions/session-1/diff/revision-1/files/file-1",
    },
    {
      routes: sessionDiffRoutes,
      method: "POST",
      path: "/sessions/session-1/diff/retry",
    },
  ])("declares $method $path as SCM-agnostic", ({ routes, method, path }) => {
    expect(findRoute(routes, method, path)).toMatchObject({ scmAgnostic: true });
  });
});
