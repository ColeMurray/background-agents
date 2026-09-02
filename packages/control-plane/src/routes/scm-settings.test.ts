import { describe, expect, it, vi } from "vitest";
import { scmSettingsRoutes } from "./scm-settings";
import type { RequestContext, Route } from "./shared";
import { matchRoute, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

function findRoute(method: string, path: string): { route: Route; match: RegExpMatchArray } {
  const matched = matchRoute(scmSettingsRoutes, method, path);
  if (!matched) throw new Error(`Missing ${method} ${path} route`);
  return { route: matched.route, match: matched.match };
}

function failingContext(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
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

  it.each([
    ["PUT", "/scm-settings", { settings: { enabledRepos: ["acme/web"] } }, "Unrecognized key"],
    [
      "PUT",
      "/scm-settings/repos/acme/web",
      { settings: { alwaysUseDraftMode: "yes" } },
      "alwaysUseDraftMode must be a boolean",
    ],
  ])("rejects malformed settings for %s %s before storage", async (method, path, body, message) => {
    const { route, match } = findRoute(method, path);

    const response = await route.handler(
      new Request(`https://test.local${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      {} as never,
      match,
      failingContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining(message),
    });
  });
});
