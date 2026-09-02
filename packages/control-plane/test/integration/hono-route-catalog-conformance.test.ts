import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routes } from "../../src/routes/catalog";
import { NO_AUTHORIZATION, type Route } from "../../src/routes/shared";
import { createControlPlaneHttpHandler } from "../../src/routing/hono-app";
import type { Env } from "../../src/types";

const PARAMETER = /:(\w+)/g;

function materializePath(
  routePath: string,
  routeIndex: number
): { pathname: string; groups: Record<string, string> } {
  const groups: Record<string, string> = {};
  const pathname = routePath.replace(PARAMETER, (_parameter, name: string) => {
    // An encoded slash remains one raw URL.pathname segment. It detects any
    // decoding before Hono selection or in the raw parameter read-back.
    const value = `fixture-${routeIndex}-${name}%2Fraw`;
    groups[name] = value;
    return value;
  });
  return { pathname, groups };
}

describe("Hono route catalog conformance", () => {
  it("dispatches every frozen method/path/policy entry with raw captures", async () => {
    const manifest = routes.map((route, routeIndex) => {
      const { pathname, groups } = materializePath(route.path, routeIndex);
      return {
        identity: `${route.method} ${route.path}`,
        pathname,
        groups,
        authentication: route.authentication.kind,
        authorization: route.authorization,
        supportedScmProviders: route.supportedScmProviders,
        cacheControl: route.cacheControl ?? null,
        hasServiceActorClaims: route.serviceActorClaims !== undefined,
      };
    });

    expect(manifest).toHaveLength(171);
    // One compact, reviewable line per frozen route keeps the fixture explicit
    // without thousands of snapshot-only formatting lines.
    expect(manifest.map((entry) => JSON.stringify(entry))).toMatchSnapshot();

    // A shadow catalog keeps the production method/path/order and replaces
    // each policy with a public echo handler, so selection and raw captures
    // are observed without mutating the production route objects.
    const shadow: Route[] = routes.map((route, routeIndex) => ({
      ...route,
      authentication: { kind: "public" },
      authorization: NO_AUTHORIZATION,
      serviceActorClaims: undefined,
      supportedScmProviders: "all",
      handler: async (_request, _env, match) =>
        Response.json({ identity: manifest[routeIndex].identity, groups: match.groups ?? {} }),
    }));
    const handle = createControlPlaneHttpHandler(shadow);

    for (const [routeIndex, route] of routes.entries()) {
      const { identity: expectedIdentity, pathname, groups } = manifest[routeIndex];
      const response = await handle(
        new Request(`https://test.local${pathname}`, { method: route.method }),
        env as unknown as Env,
        createExecutionContext()
      );

      expect(response.status, expectedIdentity).toBe(200);
      await expect(response.json(), expectedIdentity).resolves.toEqual({
        identity: expectedIdentity,
        groups,
      });
    }
  });
});
