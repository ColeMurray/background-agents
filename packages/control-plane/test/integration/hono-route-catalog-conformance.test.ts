import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { catalog } from "../../src/routes/catalog";
import { Hono } from "hono";
import { NO_AUTHORIZATION } from "../../src/routes/shared";
import { admit } from "../../src/routing/admit";
import type { ControlPlaneHonoEnv } from "../../src/routing/hono-env";
import { rawRouteParams } from "../../src/routing/route-params";
import { cloudflareHost, createControlPlaneHttpHandler } from "../../src/cloudflare/http-host";
import { createControlPlaneApp } from "../../src/routing/hono-app";
import { listRouteContracts } from "../../src/routing/route-contracts";
import { createCloudflareEnv } from "../../src/cloudflare/platform";

const PARAMETER = /:(\w+)/g;
const routes = listRouteContracts(createControlPlaneApp(catalog, cloudflareHost));

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

    // A shadow module keeps the production method/path/order and replaces
    // each policy with a public echo handler, so selection and the raw
    // parameter read-back are observed without the production policies.
    const shadow = new Hono<ControlPlaneHonoEnv>();
    const ECHO = admit({
      authentication: { kind: "public" },
      supportedScmProviders: "all",
      authorization: NO_AUTHORIZATION,
    });
    for (const [routeIndex, route] of routes.entries()) {
      shadow.on(route.method, route.path, ECHO, (c) =>
        Response.json({
          identity: manifest[routeIndex].identity,
          groups: rawRouteParams(c.req.routePath, c.req.path),
        })
      );
    }
    const handle = createControlPlaneHttpHandler([shadow]);

    for (const [routeIndex, route] of routes.entries()) {
      const { identity: expectedIdentity, pathname, groups } = manifest[routeIndex];
      const response = await handle(
        new Request(`https://test.local${pathname}`, { method: route.method }),
        createCloudflareEnv(env),
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
