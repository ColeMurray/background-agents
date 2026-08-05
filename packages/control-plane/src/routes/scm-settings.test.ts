import { describe, expect, it, vi } from "vitest";
import { scmSettingsRoutes } from "./scm-settings";
import type { RequestContext, Route } from "./shared";

function findRoute(method: string, path: string): { route: Route; match: RegExpMatchArray } {
  const route = scmSettingsRoutes.find(
    (candidate) => candidate.method === method && path.match(candidate.pattern)
  );
  if (!route) throw new Error(`Missing ${method} ${path} route`);
  return { route, match: path.match(route.pattern)! };
}

function failingContext(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    db: {
      prepare: vi.fn(() => {
        throw new Error("D1 unavailable");
      }),
    },
  } as unknown as RequestContext;
}

describe("SCM settings routes", () => {
  it.each(["/scm-settings", "/scm-settings/repos"])(
    "maps storage read failures for GET %s to 503",
    async (path) => {
      const { route, match } = findRoute("GET", path);

      const response = await route.handler(
        new Request(`https://test.local${path}`),
        {} as never,
        match,
        failingContext()
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "SCM settings storage unavailable",
      });
    }
  );
});
